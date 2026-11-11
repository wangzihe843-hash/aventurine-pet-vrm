/**
 * 单测：DSH 强耦合生命周期状态机（`src/main/desktop/dsh-lifecycle.ts`，Wave 3 A3 +
 * 2026-11-11 兼容性安全 v2）。
 *
 * **离线全注入**：DSH 进程控制器、配置 getter、定时器、时钟、quit 动作、DSH 版本探测、
 * 桥目录状态、安全模式、告警回调全部是 fake；本文件绝不执行真实 `open -b`/`pgrep`、
 * 绝不向真实 DSH 发信号、不读写真实 `~/.dsh`。
 *
 * 覆盖（契约 §1 + v2 计划 §2/§6.2 + §7.3 验收矩阵）：
 * - 启用规则（dev/打包/config/env/safe-mode）；
 * - 握手四门槛：进程 + status.online + control.attached + compat ok/legacy（陈旧帧不得 PAIRED）；
 * - STARTING：拉起 + 限流 + 180s 拉起失败 → DEGRADED(startup-failed)；
 * - UNPAIRED：20s 超时 → DEGRADED(no-bridge-unpaired / compat-unverified)，进程消失 → dsh-degraded；
 * - PAIRED：崩溃重启 ≤2 次 → DEGRADED(crash-recovery-failed)（不再级联自杀）；心跳丢失 30s →
 *   DEGRADED(bridge-lost)；detached grace / 显式退出 dsh-exit 语义保持；
 * - DEGRADED：不 launch/不 restart/不 terminate；进程消失 → dsh-degraded；自动恢复 PAIRED；
 * - before-quit：仅 PAIRED 才 SIGTERM DSH；DEGRADED/UNPAIRED/DISABLED 放行；
 * - 告警：每次进入 DEGRADED 一次 / 恢复 PAIRED 一次；DEGRADED 期间不重复告警；
 * - safe-mode 文件热生效/热失效；配置热更；stop 不残留定时器。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DshBridgeControlFile, DshBridgeInstallManifest } from '@shared/bridge-schema'
import { BRIDGE_LEGACY_DSH_RANGE } from '@shared/bridge-schema'
import type { DshStatus } from '@shared/types'

import type { BridgeDirState } from '../src/main/desktop/dsh-bridge-state'
import {
  DSH_BRIDGE_LOST_GRACE_MS,
  DSH_CONTROL_GRACE_MS,
  DSH_LIFECYCLE_TICK_MS,
  DSH_LAUNCH_COOLDOWN_MS,
  DSH_LAUNCH_WINDOW_MS,
  DSH_MAX_LAUNCHES_PER_WINDOW,
  DSH_MAX_RESTARTS,
  DSH_RESTART_INTERVAL_MS,
  DSH_STARTUP_GIVEUP_MS,
  DSH_UNPAIRED_GRACE_MS,
  PET_DSH_COUPLING_DISABLE_ENV,
  PET_DSH_COUPLING_ENV,
  createDshLifecycle,
  isDshCouplingEnabled
} from '../src/main/desktop/dsh-lifecycle'
import type {
  CreateDshLifecycleOptions,
  DshCouplingAlert,
  DshCouplingConfig,
  DshLifecycle,
  DshLifecycleTimers,
  DshQuitReason
} from '../src/main/desktop/dsh-lifecycle'
import type { DshProcess, DshProcessPolicy, DshTerminateResult } from '../src/main/desktop/dsh-process'

/* ------------------------------ fake scheduler ---------------------------- */

interface FakeTimerEntry {
  at: number
  callback: () => void
  interval: number | null
}

/**
 * 手动调度器：`advance(ms)` 逐条触发到期定时器，**每个回调后都结算微任务**
 * （tick/恢复/握手评估是 async；不等微任务就触发下一个定时器会让重入保护吃掉 tick，
 *  与生产定时器行为不符）。确定性、无真实等待。
 */
class FakeScheduler implements DshLifecycleTimers {
  time = 0
  private nextId = 1
  private readonly entries = new Map<number, FakeTimerEntry>()

  now = (): number => this.time

  setInterval(callback: () => void, ms: number): unknown {
    return this.add(callback, ms, ms)
  }

  clearInterval(handle: unknown): void {
    this.entries.delete(handle as number)
  }

  setTimeout(callback: () => void, ms: number): unknown {
    return this.add(callback, ms, null)
  }

  clearTimeout(handle: unknown): void {
    this.entries.delete(handle as number)
  }

  /** 当前排队的定时器数量（断言 stop/清 grace 用）。 */
  get pending(): number {
    return this.entries.size
  }

  private add(callback: () => void, ms: number, interval: number | null): number {
    const id = this.nextId
    this.nextId += 1
    this.entries.set(id, { at: this.time + ms, callback, interval })
    return id
  }

  /** 最早的到期时刻（无定时器 → null）。 */
  earliest(): number | null {
    let minimum: number | null = null
    for (const entry of this.entries.values()) {
      if (minimum === null || entry.at < minimum) minimum = entry.at
    }
    return minimum
  }

  /** 触发所有 `at <= 当前 time` 的定时器（interval 触发后重新排期）。 */
  fireDue(): void {
    for (let guard = 0; guard < 1000; guard += 1) {
      let chosenId: number | null = null
      let chosenAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.entries) {
        if (entry.at <= this.time && entry.at < chosenAt) {
          chosenAt = entry.at
          chosenId = id
        }
      }
      if (chosenId === null) return
      const entry = this.entries.get(chosenId)
      if (!entry) return
      if (entry.interval === null) this.entries.delete(chosenId)
      else entry.at = this.time + entry.interval
      entry.callback()
    }
    throw new Error('FakeScheduler.fireDue 死循环（测试调度器保护）')
  }
}

/* ------------------------------- fake process ----------------------------- */

const FAKE_POLICY: DshProcessPolicy = {
  processPattern: 'fake-dsh',
  launchMode: 'open-bundle',
  launchCommand: null,
  terminateTimeoutMs: 5000,
  testHooks: false
}

class FakeDshProcess implements DshProcess {
  readonly policy: DshProcessPolicy = FAKE_POLICY
  running = false
  pid: number | null = 4321
  launchCalls = 0
  terminateCalls: number[] = []
  /** 拉起成功后是否把 running 置 true（模拟 open 成功启动）。 */
  launchMakesRunning = false
  launchResult = true
  terminateResult: DshTerminateResult = 'terminated'
  terminateThrows = false
  terminateHangs = false

  async isRunning(): Promise<boolean> {
    return this.running
  }

  async getPid(): Promise<number | null> {
    return this.pid
  }

  async launch(): Promise<boolean> {
    this.launchCalls += 1
    if (this.launchMakesRunning) this.running = true
    return this.launchResult
  }

  async terminate(pid: number): Promise<DshTerminateResult> {
    this.terminateCalls.push(pid)
    if (this.terminateHangs) return new Promise<DshTerminateResult>(() => {})
    if (this.terminateThrows) throw new Error('terminate boom')
    this.running = false
    return this.terminateResult
  }
}

/* ----------------------------- 握手帧 / 状态夹具 ---------------------------- */

/** 现网桥声明范围（v3/v4 一致）。 */
const V4_RANGE = '>=0.2.2-rc.1 <0.3.0'

/** v4 attached 控制帧（带 compat；健康握手的默认帧）。 */
function v4Attached(ts: number): DshBridgeControlFile {
  return {
    schemaVersion: 1,
    ts,
    action: 'attached',
    dshPid: 4321,
    bridgeVersion: 4,
    compat: { bridgeVersion: 4, controlSchema: 1, dshRange: V4_RANGE }
  }
}

/** v3 legacy attached 控制帧（无 compat，走 BRIDGE_LEGACY_DSH_RANGE 回退）。 */
function legacyAttached(ts: number): DshBridgeControlFile {
  return { schemaVersion: 1, ts, action: 'attached', dshPid: 4321, bridgeVersion: 3 }
}

/** detached 控制帧。 */
function detached(ts: number): DshBridgeControlFile {
  return {
    schemaVersion: 1,
    ts,
    action: 'detached',
    dshPid: 4321,
    bridgeVersion: 4,
    compat: { bridgeVersion: 4, controlSchema: 1, dshRange: V4_RANGE }
  }
}

const ONLINE_STATUS: DshStatus = {
  online: true,
  running: true,
  lastEventAt: 1,
  lastType: 'task/start'
}

/** watcher 心跳 TTL 到期时推送的离线状态（online=false）。 */
const OFFLINE_STATUS: DshStatus = {
  online: false,
  running: false,
  lastEventAt: 0,
  lastType: null
}

/** 安装清单夹具（E6 静态信号）。 */
function manifest(overrides: Partial<DshBridgeInstallManifest> = {}): DshBridgeInstallManifest {
  return {
    schemaVersion: 1,
    installedAt: 1_794_371_618_741,
    installMethod: 'live-copy-insert',
    bridgeEntry: '/tmp/live-bridge/rev-1/lib/index.js',
    bridgePackageName: 'dsh-aventurine-bridge',
    bridgePackageVersion: '0.2.0',
    bridgeVersion: 4,
    controlSchema: 1,
    dshRange: V4_RANGE,
    dshVersionAtInstall: '0.2.2-rc.1',
    ...overrides
  }
}

/* --------------------------------- harness -------------------------------- */

interface HarnessOptions {
  isPackaged?: boolean
  env?: NodeJS.ProcessEnv
  config?: DshCouplingConfig
  /** 创建时 DSH 是否已在运行（决定首轮 tick 是否拉起）。 */
  running?: boolean
  /** fake `launch()` 的返回值（false 模拟 DSH 未安装/拉起失败）。 */
  launchResult?: boolean
  /** 注入的 DSH 版本（默认 0.2.2-rc.1；null = 读不到 = 不可验证）。 */
  dshVersion?: string | null
  /** 自动注入的握手帧形态（v4 compat / v3 legacy）。 */
  handshakePreset?: 'v4' | 'legacy'
  /** 启动时若 DSH 在运行，是否自动注入健康握手（默认 true）。 */
  autoHandshake?: boolean
  /** 安全模式初值（可热更）。 */
  safeMode?: boolean
  /** 桥目录静态状态（install.json / bridge-error.json）。 */
  dirState?: BridgeDirState
  lifecycle?: Partial<CreateDshLifecycleOptions>
}

/** 结算微任务（fake 定时器下 await Promise.resolve 循环即可覆盖我们的异步链）。 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 60; i += 1) await Promise.resolve()
}

class Harness {
  readonly scheduler = new FakeScheduler()
  readonly process = new FakeDshProcess()
  readonly config: DshCouplingConfig
  readonly env: NodeJS.ProcessEnv
  readonly quits: DshQuitReason[] = []
  readonly alerts: DshCouplingAlert[] = []
  /** 安全模式开关（isSafeMode 注入读这里；测试可热改）。 */
  readonly safeMode: { active: boolean }
  /** 可热改的 DSH 版本（模拟版本更新/探测恢复）。 */
  dshVersion: string | null
  readonly handshakePreset: 'v4' | 'legacy'
  readonly dirState: BridgeDirState
  readonly lifecycle: DshLifecycle

  constructor(options: HarnessOptions = {}) {
    this.process.running = options.running === true
    this.process.launchResult = options.launchResult ?? true
    this.config = options.config ?? { dshCoupling: true }
    this.env = options.env ?? {}
    this.safeMode = { active: options.safeMode === true }
    this.dshVersion = options.dshVersion === undefined ? '0.2.2-rc.1' : options.dshVersion
    this.handshakePreset = options.handshakePreset ?? 'v4'
    this.dirState = options.dirState ?? { installManifest: null, diagnostic: null, dir: '/fake-dsh' }
    this.lifecycle = createDshLifecycle({
      process: this.process,
      getConfig: () => this.config,
      isPackaged: options.isPackaged ?? true,
      env: this.env,
      now: this.scheduler.now,
      timers: this.scheduler,
      quit: (reason) => {
        this.quits.push(reason)
      },
      getDshVersion: async (): Promise<string | null> => this.dshVersion,
      readBridgeDirState: () => this.dirState,
      isSafeMode: () => this.safeMode.active,
      onCouplingAlert: (alert) => {
        this.alerts.push(alert)
      },
      ...options.lifecycle
    })
  }

  /** 当前握手形态对应的 attached 帧。 */
  attachedFrame(ts = this.scheduler.time + 1): DshBridgeControlFile {
    return this.handshakePreset === 'legacy' ? legacyAttached(ts) : v4Attached(ts)
  }

  /** 注入健康握手：进程在跑 + status online + control attached（形态由 preset 决定）。 */
  async pair(): Promise<void> {
    this.process.running = true
    this.lifecycle.handleStatus(ONLINE_STATUS)
    this.lifecycle.handleControl(this.attachedFrame())
    await flushMicrotasks()
  }

  /** 注入一次 status 心跳（online=false 模拟 watcher TTL 到期）。 */
  async feedStatus(status: DshStatus = ONLINE_STATUS): Promise<void> {
    this.lifecycle.handleStatus(status)
    await flushMicrotasks()
  }

  /** 注入一个 control 帧。 */
  async feedControl(frame: DshBridgeControlFile): Promise<void> {
    this.lifecycle.handleControl(frame)
    await flushMicrotasks()
  }

  /** 推进假时钟：逐条触发到期定时器，每个回调后结算微任务。 */
  async advance(ms: number): Promise<void> {
    const target = this.scheduler.time + ms
    for (let guard = 0; guard < 5000; guard += 1) {
      const due = this.scheduler.earliest()
      if (due === null || due > target) break
      this.scheduler.time = due
      this.scheduler.fireDue()
      await flushMicrotasks()
    }
    this.scheduler.time = target
    await flushMicrotasks()
  }
}

/** 创建并 start harness（running=true 时默认自动注入健康握手）。 */
async function started(options: HarnessOptions = {}): Promise<Harness> {
  const harness = new Harness(options)
  harness.lifecycle.start()
  await flushMicrotasks()
  if (options.running === true && options.autoHandshake !== false) {
    await harness.pair()
  }
  return harness
}

/** 启动并进入 PAIRED（断言握手门槛通过）。 */
async function pairRunning(options: HarnessOptions = { running: true }): Promise<Harness> {
  const harness = await started(options)
  expect(harness.lifecycle.getState()).toBe('PAIRED')
  return harness
}

afterEach(() => {
  vi.restoreAllMocks()
})

/* ------------------------------ 启用规则（纯函数） ------------------------- */

describe('isDshCouplingEnabled：dev 安全 / disable 强制关 / config 开关', () => {
  it('打包版：默认启用；config false 关闭', () => {
    expect(isDshCouplingEnabled({ isPackaged: true, env: {}, config: {} })).toBe(true)
    expect(isDshCouplingEnabled({ isPackaged: true, env: {}, config: { dshCoupling: true } })).toBe(
      true
    )
    expect(isDshCouplingEnabled({ isPackaged: true, env: {}, config: { dshCoupling: false } })).toBe(
      false
    )
  })

  it('dev（未打包）：默认关闭，必须显式 PET_DSH_COUPLING=1', () => {
    expect(isDshCouplingEnabled({ isPackaged: false, env: {}, config: {} })).toBe(false)
    expect(
      isDshCouplingEnabled({ isPackaged: false, env: { [PET_DSH_COUPLING_ENV]: '1' }, config: {} })
    ).toBe(true)
    expect(
      isDshCouplingEnabled({ isPackaged: false, env: { [PET_DSH_COUPLING_ENV]: '0' }, config: {} })
    ).toBe(false)
  })

  it('PET_DSH_COUPLING_DISABLE=1 在任何构建下强制关闭（最高优先）', () => {
    expect(
      isDshCouplingEnabled({
        isPackaged: true,
        env: { [PET_DSH_COUPLING_DISABLE_ENV]: '1' },
        config: { dshCoupling: true }
      })
    ).toBe(false)
    expect(
      isDshCouplingEnabled({
        isPackaged: false,
        env: { [PET_DSH_COUPLING_ENV]: '1', [PET_DSH_COUPLING_DISABLE_ENV]: '1' },
        config: {}
      })
    ).toBe(false)
  })
})

describe('生命周期：启用/禁用', () => {
  it('dev 默认禁用：start 后保持 DISABLED，不做任何拉起/探测动作', async () => {
    const harness = await started({ isPackaged: false, env: {} })
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    expect(harness.lifecycle.isEnabled()).toBe(false)
    await harness.advance(10_000)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('config.dshCoupling=false（打包版）也禁用', async () => {
    const harness = await started({ config: { dshCoupling: false } })
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    await harness.advance(10_000)
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })

  it('PET_DSH_COUPLING_DISABLE=1 覆盖打包版默认启用', async () => {
    const harness = await started({
      env: { [PET_DSH_COUPLING_DISABLE_ENV]: '1' },
      config: { dshCoupling: true }
    })
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    expect(harness.lifecycle.isEnabled()).toBe(false)
    harness.lifecycle.stop()
  })

  it('dev + PET_DSH_COUPLING=1：启用并进入 STARTING', async () => {
    const harness = await started({
      isPackaged: false,
      env: { [PET_DSH_COUPLING_ENV]: '1' },
      config: {}
    })
    expect(harness.lifecycle.isEnabled()).toBe(true)
    // DSH 未运行 → 立即尝试拉起一次
    expect(harness.lifecycle.getState()).toBe('STARTING')
    expect(harness.process.launchCalls).toBe(1)
    harness.lifecycle.stop()
  })
})

/* --------------------------------- STARTING -------------------------------- */

describe('STARTING：启动 ensure + 拉起限流 + 握手门槛', () => {
  it('DSH 已在运行且握手健康 → 直接 PAIRED，不拉起', async () => {
    const harness = await started({ running: true })
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })

  it('DSH 未运行 → 拉起；60s 冷却 + 最多 3 次/90s 窗口限流', async () => {
    const harness = await started()
    expect(harness.lifecycle.getState()).toBe('STARTING')
    expect(harness.process.launchCalls).toBe(1)

    // 3s tick 不重复拉起（冷却 60s）
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.process.launchCalls).toBe(1)

    // 到达 60s 冷却 → 第 2 次
    await harness.advance(DSH_LAUNCH_COOLDOWN_MS - DSH_LIFECYCLE_TICK_MS)
    expect(harness.process.launchCalls).toBe(2)

    // 120s → 第 3 次
    await harness.advance(DSH_LAUNCH_COOLDOWN_MS)
    expect(harness.process.launchCalls).toBe(3)

    // 150s：窗口内已 3 次且距上次 30s（<60s）→ 不再拉起
    await harness.advance(DSH_LAUNCH_COOLDOWN_MS / 2)
    expect(harness.process.launchCalls).toBe(3)
    expect(DSH_MAX_LAUNCHES_PER_WINDOW).toBe(3)
    expect(DSH_LAUNCH_WINDOW_MS).toBe(90_000)
    harness.lifecycle.stop()
  })

  it('后续探测到 DSH 运行但握手未就绪 → UNPAIRED；补齐握手 → PAIRED', async () => {
    const harness = await started()
    expect(harness.process.launchCalls).toBe(1)
    harness.process.running = true
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    // 进程在跑但 status/control 都没就绪：v2 门槛下不得 PAIRED
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    await harness.pair()
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.process.launchCalls).toBe(1)
    harness.lifecycle.stop()
  })

  it('仅 attached 控制帧（进程未运行/无心跳）不得 PAIRED —— 四门槛硬要求', async () => {
    const harness = await started({ autoHandshake: false })
    await harness.feedControl(v4Attached(harness.scheduler.time))
    expect(harness.lifecycle.getState()).not.toBe('PAIRED')

    // 补第 1 项（进程在跑）+ 第 2 项（心跳 online）后才允许 PAIRED
    harness.process.running = true
    await harness.feedStatus(ONLINE_STATUS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })

  it('仅 status online 心跳（无 control attached）不得 PAIRED', async () => {
    const harness = await started({ running: true, autoHandshake: false })
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    await harness.feedStatus(ONLINE_STATUS)
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    await harness.feedControl(v4Attached(harness.scheduler.time))
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })
})

/* ------------------------------ PAIRED 崩溃恢复 ---------------------------- */

describe('PAIRED：进程消失 → 冷却内重启 ≤2 次（v2：仍失败转 DEGRADED，不自杀）', () => {
  it('第一次重启成功 → 恢复 PAIRED，不退出', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    harness.process.launchMakesRunning = true

    await harness.advance(DSH_LIFECYCLE_TICK_MS) // 探测到消失 → 进入确认窗口（不立即拉起）
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.quits).toEqual([])

    await harness.advance(DSH_CONTROL_GRACE_MS) // 确认窗口到期：无 detached → 按崩溃重启第 1 次
    expect(harness.process.launchCalls).toBe(1)
    await harness.advance(DSH_RESTART_INTERVAL_MS) // 5s 后验证：已恢复
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.quits).toEqual([])
    expect(harness.process.launchCalls).toBe(1)
    harness.lifecycle.stop()
  })

  it('两次重启均失败 → DEGRADED(crash-recovery-failed)，不 quit、不再拉起（§7.3 #11）', async () => {
    const harness = await pairRunning()
    harness.process.running = false

    await harness.advance(DSH_LIFECYCLE_TICK_MS) // 确认窗口
    expect(harness.process.launchCalls).toBe(0)
    await harness.advance(DSH_CONTROL_GRACE_MS) // 确认窗口到期 → 恢复 attempt 1
    expect(harness.process.launchCalls).toBe(1)
    await harness.advance(DSH_RESTART_INTERVAL_MS) // 验证失败 → attempt 2
    expect(harness.process.launchCalls).toBe(2)
    await harness.advance(DSH_RESTART_INTERVAL_MS) // 验证失败 → DEGRADED

    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.lifecycle.getQuitReason()).toBeNull()
    expect(harness.quits).toEqual([]) // v2：不再 cascade('dsh-gone') 自杀
    expect(harness.process.launchCalls).toBe(DSH_MAX_RESTARTS)
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'crash-recovery-failed' })

    // 常驻等待（进入降级时 DSH 已不在运行 → 不跟随退出），之后不再拉起
    await harness.advance(120_000)
    expect(harness.quits).toEqual([])
    expect(harness.process.launchCalls).toBe(DSH_MAX_RESTARTS)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    harness.lifecycle.stop()
  })

  it('恢复过程中桥重新 attached → 取消重启，不退出', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    await harness.advance(DSH_LIFECYCLE_TICK_MS) // 确认窗口
    expect(harness.process.launchCalls).toBe(0)
    await harness.advance(DSH_CONTROL_GRACE_MS) // 确认窗口到期 → attempt 1
    expect(harness.process.launchCalls).toBe(1)

    // attached 说明桥已恢复 → 同步把 fake 进程标记为在运行，避免下一轮 tick 再次判定消失。
    harness.process.running = true
    await harness.feedControl(v4Attached(harness.scheduler.time))
    await harness.advance(30_000)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.quits).toEqual([])
    expect(harness.process.launchCalls).toBe(1)
    harness.lifecycle.stop()
  })
})

/* ------------------------- detached → grace 竞态 --------------------------- */

describe('control detached → 1.5s grace（HMR 竞态）', () => {
  it('grace 内重新 attached → 取消疑似退出，不重启不退出', async () => {
    const harness = await pairRunning()
    await harness.feedControl(detached(harness.scheduler.time))

    await harness.advance(DSH_CONTROL_GRACE_MS / 2) // 750ms < grace
    await harness.feedControl(v4Attached(harness.scheduler.time + 10))

    await harness.advance(30_000)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('grace 到期无 attached 且进程已不在 → 直接跟随退出（dsh-exit，不重启）', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    await harness.feedControl(detached(harness.scheduler.time))

    await harness.advance(DSH_CONTROL_GRACE_MS)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-exit')
    expect(harness.quits).toEqual(['dsh-exit'])
    harness.lifecycle.stop()
  })

  it('grace 到期但 DSH 进程仍在运行（HMR/插件卸载）→ 保持 PAIRED，不重启不退出', async () => {
    const harness = await pairRunning()
    await harness.feedControl(detached(harness.scheduler.time))

    await harness.advance(DSH_CONTROL_GRACE_MS + DSH_RESTART_INTERVAL_MS * 3)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })

  it('进程先消失、但 grace 内桥重新 attached（HMR 重载完成）→ 取消退出判定', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    await harness.feedControl(detached(harness.scheduler.time))
    await harness.advance(DSH_CONTROL_GRACE_MS / 2)

    harness.process.running = true
    await harness.feedControl(v4Attached(harness.scheduler.time + 500))
    await harness.advance(30_000)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.quits).toEqual([])
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })

  it('STARTING 阶段 detached grace 到期后探测到运行 → 握手不全进 UNPAIRED，补齐后 PAIRED', async () => {
    const harness = await started()
    expect(harness.lifecycle.getState()).toBe('STARTING')
    await harness.feedControl(detached(harness.scheduler.time))
    harness.process.running = true
    await harness.advance(DSH_CONTROL_GRACE_MS)
    // detached 后 controlAttached=false + status 未 online → 不得直接 PAIRED
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    await harness.feedStatus(ONLINE_STATUS)
    await harness.feedControl(v4Attached(harness.scheduler.time))
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })
})

/* ------------- 2026-11-11 实机 bug 回归：显式退出绝不触发重启 ---------------- */
/*
 * 实机 bug（12:48 日志）：用户关闭 DSH → 桥写 detached → 3s tick 抢在 1.5s grace
 * 到期前探测到进程消失 → 旧实现按崩溃流程 open -b 重新拉起 DSH（桌宠没退出反而重开 DSH）。
 * 这里覆盖三条路径：tick 早于 grace、watcher 晚于 tick 读到 detached、grace 到期进程仍在
 * 但之后消失。全部要求「跟随退出 dsh-exit，0 次 restart」。
 */

describe('显式退出语义：收到 detached 后绝不重启 DSH（不把 DSH 拉回来）', () => {
  it('3s tick 先于 1.5s grace 探测到进程消失 → 不重启，grace 到期跟随退出', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    harness.process.launchMakesRunning = true // 若错误重启，会真的“恢复”，必须断言 0 次拉起

    await harness.advance(2000) // 相位：detached 后 grace 到期时刻(3500) > 下一次 tick(3000)
    await harness.feedControl(detached(harness.scheduler.time))
    await harness.advance(DSH_LIFECYCLE_TICK_MS / 3) // 3000：tick 在 grace 到期前观察到进程消失
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('PAIRED')

    await harness.advance(DSH_CONTROL_GRACE_MS / 3) // 3500：grace 到期 → 显式退出
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-exit')
    expect(harness.quits).toEqual(['dsh-exit'])
    harness.lifecycle.stop()
  })

  it('tick 先看到进程消失、detached 在确认窗口内才到达 → 取消重启，跟随退出', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    harness.process.launchMakesRunning = true

    await harness.advance(DSH_LIFECYCLE_TICK_MS) // tick 探测到消失（此时 watcher 还没读到 detached 帧）
    expect(harness.process.launchCalls).toBe(0) // 确认窗口内不得立即拉起
    expect(harness.lifecycle.getState()).toBe('PAIRED')

    await harness.feedControl(detached(harness.scheduler.time)) // watcher 随后读到 detached
    await harness.advance(DSH_CONTROL_GRACE_MS)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-exit')
    harness.lifecycle.stop()
  })

  it('grace 到期进程仍在（HMR/插件卸载），之后进程消失 → 跟随退出而非重启', async () => {
    const harness = await pairRunning()
    await harness.feedControl(detached(harness.scheduler.time))

    await harness.advance(DSH_CONTROL_GRACE_MS) // 进程仍在 → 保持 PAIRED 等待重新 attached
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('PAIRED')

    harness.process.running = false // 等待期间 DSH 才真正退出
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-exit')
    expect(harness.quits).toEqual(['dsh-exit'])
    harness.lifecycle.stop()
  })

  it('detached 后重新 attached → 清除显式退出标记，真崩溃仍按重启恢复', async () => {
    const harness = await pairRunning()
    await harness.feedControl(detached(harness.scheduler.time))
    await harness.feedControl(v4Attached(harness.scheduler.time + 10))
    harness.process.running = false
    harness.process.launchMakesRunning = true

    await harness.advance(DSH_LIFECYCLE_TICK_MS) // 确认窗口
    expect(harness.process.launchCalls).toBe(0)
    await harness.advance(DSH_CONTROL_GRACE_MS) // 无 detached → 按崩溃重启
    expect(harness.process.launchCalls).toBe(1)
    await harness.advance(DSH_RESTART_INTERVAL_MS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('重启恢复过程中收到 detached → 立即作废重启（不再拉起第 2 次）并跟随退出', async () => {
    const harness = await pairRunning()
    harness.process.running = false

    await harness.advance(DSH_LIFECYCLE_TICK_MS) // 确认窗口
    await harness.advance(DSH_CONTROL_GRACE_MS) // 无 detached → attempt 1（拉起）
    expect(harness.process.launchCalls).toBe(1)

    await harness.feedControl(detached(harness.scheduler.time)) // 显式退出帧终于被读到
    await harness.advance(DSH_CONTROL_GRACE_MS) // grace 到期：进程不在 → 跟随退出
    expect(harness.process.launchCalls).toBe(1) // 没有第 2 次重启
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-exit')
    harness.lifecycle.stop()
  })
})

/* ------------------------------- before-quit ------------------------------ */

describe('before-quit：仅 PAIRED 才 SIGTERM DSH（其余状态放行，防互杀环）', () => {
  function preventEvent() {
    return { preventDefault: vi.fn() }
  }

  it('PAIRED 且 DSH 在运行 → preventDefault 一次 → terminate(pid) → quit(pet-exit)；第二次放行', async () => {
    const harness = await pairRunning()

    const first = preventEvent()
    harness.lifecycle.handleBeforeQuit(first)
    expect(first.preventDefault).toHaveBeenCalledTimes(1)

    await flushMicrotasks()
    expect(harness.process.terminateCalls).toEqual([4321])
    expect(harness.quits).toEqual(['pet-exit'])

    // 模拟 app.quit() 触发的第二次 before-quit：必须放行，且不重复终止。
    const second = preventEvent()
    harness.lifecycle.handleBeforeQuit(second)
    expect(second.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([4321])
    harness.lifecycle.stop()
  })

  it('DSH 已知未运行（STARTING）→ 直接放行（不 preventDefault、不终止）', async () => {
    // 拉起失败（如 DSH 未安装）→ lastKnownRunning 保持 false，且状态非 PAIRED。
    const harness = await started({ launchResult: false })
    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('禁用耦合 → 放行，绝不终止 DSH', async () => {
    const harness = await started({ isPackaged: false, env: {} })
    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })

  it('UNPAIRED 下 before-quit → 放行，不杀 DSH（安全语义）', async () => {
    const harness = await started({ running: true, autoHandshake: false })
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')
    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })

  it('DEGRADED 下 before-quit → 不 preventDefault、不 terminate、不请求退出（§7.3 #7）', async () => {
    const harness = await started({ running: true, dshVersion: '0.3.0' })
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('级联退出（DSH 显式退出）时 before-quit 放行，不再向 DSH 发信号', async () => {
    const harness = await pairRunning()
    harness.process.running = false
    await harness.feedControl(detached(harness.scheduler.time))
    await harness.advance(DSH_CONTROL_GRACE_MS)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.quits).toEqual(['dsh-exit'])

    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })

  it('拿不到 pid → 不终止但仍完成退出握手', async () => {
    const harness = await pairRunning()
    harness.process.pid = null

    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    await flushMicrotasks()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual(['pet-exit'])

    const second = preventEvent()
    harness.lifecycle.handleBeforeQuit(second)
    expect(second.preventDefault).not.toHaveBeenCalled() // 不会死循环卡住退出
    harness.lifecycle.stop()
  })

  it('终止异常 → 记录后继续退出（失败只 log，不卡退出）', async () => {
    const harness = await pairRunning()
    harness.process.terminateThrows = true

    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    await flushMicrotasks()
    expect(harness.process.terminateCalls).toEqual([4321])
    expect(harness.quits).toEqual(['pet-exit'])
    harness.lifecycle.stop()
  })

  it('退出流程进行中 DSH 消失 → 绝不重新拉起/重启（避免退出时又拉起 DSH）', async () => {
    const harness = await pairRunning()
    harness.process.terminateHangs = true

    const event = preventEvent()
    harness.lifecycle.handleBeforeQuit(event)
    await flushMicrotasks()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(harness.process.terminateCalls).toEqual([4321]) // 终止流程已卡在 SIGTERM 等待

    harness.process.running = false // DSH 在退出流程中消失
    await harness.advance(30_000)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('终止流程进行中再次 before-quit → 继续拦截（等流程收尾）', async () => {
    const harness = await pairRunning()
    harness.process.terminateHangs = true

    const first = preventEvent()
    harness.lifecycle.handleBeforeQuit(first)
    await flushMicrotasks()
    expect(harness.process.terminateCalls).toEqual([4321])

    const second = preventEvent()
    harness.lifecycle.handleBeforeQuit(second)
    expect(second.preventDefault).toHaveBeenCalledTimes(1)
    expect(harness.quits).toEqual([]) // 尚未完成
    harness.lifecycle.stop()
  })
})

/* --------------------------- 配置热更 / stop ------------------------------ */

describe('配置热更与 stop', () => {
  it('运行中关闭 dshCoupling → DISABLED 且不再动作；重新开启 → 恢复 PAIRED', async () => {
    const harness = await pairRunning()

    harness.config.dshCoupling = false
    harness.lifecycle.refreshConfig()
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    expect(harness.lifecycle.isEnabled()).toBe(false)
    await harness.advance(30_000)
    expect(harness.quits).toEqual([])
    expect(harness.process.terminateCalls).toEqual([])

    harness.config.dshCoupling = true
    harness.lifecycle.refreshConfig()
    await flushMicrotasks()
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })

  it('stop 后不再触发 grace/重启/级联', async () => {
    const harness = await pairRunning()
    await harness.feedControl(detached(harness.scheduler.time))
    harness.lifecycle.stop()

    await harness.advance(60_000)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    expect(harness.scheduler.pending).toBe(0)
  })
})

/* --------------------------- §7.3 验收矩阵（v2） --------------------------- */

describe('§7.3 #2 陈旧 control/status（桥未加载）→ 不 PAIRED、UNPAIRED 超时降级、不重启', () => {
  it('上次会话遗留 attached 帧 + 无新鲜心跳 → UNPAIRED → 20s → DEGRADED(bridge-not-loaded)', async () => {
    const harness = await started({ running: true, autoHandshake: false })
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    // watcher 启动时读到上次会话遗留的 attached（ts 很旧）+ 没有 status 心跳
    await harness.feedControl(v4Attached(harness.scheduler.time - 60_000))
    expect(harness.lifecycle.getState()).toBe('UNPAIRED') // 陈旧单帧绝不得 PAIRED

    await harness.advance(DSH_UNPAIRED_GRACE_MS / 2)
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    await harness.advance(DSH_UNPAIRED_GRACE_MS)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'bridge-not-loaded' })
    expect(harness.process.launchCalls).toBe(0) // 绝不重启/拉起
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('降级 detail 带 bridge-error.json 诊断（E6 可解释性）', async () => {
    const harness = await started({
      running: true,
      autoHandshake: false,
      dirState: {
        installManifest: null,
        diagnostic: {
          schemaVersion: 1,
          ts: 1,
          phase: 'apply',
          message: 'Error: bridge apply failed'
        },
        dir: '/fake-dsh'
      }
    })
    await harness.advance(DSH_UNPAIRED_GRACE_MS + 10_000)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts[0]?.reason).toContain('bridge apply failed')
    harness.lifecycle.stop()
  })
})

describe('§7.3 #3 compat 不兼容 → 立即 DEGRADED，不杀/不重启', () => {
  it('DSH 0.3.0 不满足桥声明范围 → 立即 DEGRADED(compat-incompatible)，0 次 launch/terminate', async () => {
    const harness = await started({ running: true, dshVersion: '0.3.0' })
    // 不依赖 20s 超时：握手评估发现明确不兼容就立即降级
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({
      kind: 'degraded',
      code: 'compat-incompatible',
      dshVersion: '0.3.0',
      bridgeVersion: 4,
      state: 'DEGRADED'
    })
    expect(harness.alerts[0]?.reason).toContain(V4_RANGE)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.process.terminateCalls).toEqual([])

    await harness.advance(120_000)
    expect(harness.quits).toEqual([])
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    harness.lifecycle.stop()
  })

  it('PAIRED 中收到不兼容的 compat 帧（如 HMR 加载了未来桥）→ 立即降级且不杀 DSH', async () => {
    const harness = await pairRunning()
    await harness.feedControl({
      schemaVersion: 1,
      ts: harness.scheduler.time + 1,
      action: 'attached',
      dshPid: 4321,
      bridgeVersion: 5,
      compat: { bridgeVersion: 5, controlSchema: 1, dshRange: V4_RANGE }
    })
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts[0]).toMatchObject({
      kind: 'degraded',
      code: 'compat-incompatible'
    })
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })
})

describe('§7.3 #4 v3 legacy 桥双向', () => {
  it('v3 legacy（无 compat）+ DSH 0.2.2-rc.1 → PAIRED（BRIDGE_LEGACY_DSH_RANGE 回退）', async () => {
    const harness = await started({ running: true, handshakePreset: 'legacy' })
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts).toEqual([])
    harness.lifecycle.stop()
  })

  it('v3 legacy + DSH 0.3.0 不在 legacy 范围 → 立即 DEGRADED（detail 带 legacy 范围）', async () => {
    const harness = await started({
      running: true,
      handshakePreset: 'legacy',
      dshVersion: '0.3.0'
    })
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({
      kind: 'degraded',
      code: 'compat-incompatible',
      dshVersion: '0.3.0',
      bridgeVersion: 3,
      dshRange: BRIDGE_LEGACY_DSH_RANGE
    })
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })
})

describe('§7.3 #5 DSH 版本未知 → 不猜兼容，超时 DEGRADED(compat-unverified)', () => {
  it('版本读不到 → 不 PAIRED；20s 超时 → compat-unverified', async () => {
    const harness = await started({ running: true, dshVersion: null })
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')
    expect(harness.alerts).toEqual([])

    await harness.advance(DSH_UNPAIRED_GRACE_MS + 5_000)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'compat-unverified' })
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.quits).toEqual([])
    harness.lifecycle.stop()
  })

  it('版本探测恢复（如 Info.plist 变得可读）→ DEGRADED 自动恢复 PAIRED', async () => {
    const harness = await started({ running: true, dshVersion: null })
    await harness.advance(DSH_UNPAIRED_GRACE_MS + 5_000)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')

    harness.dshVersion = '0.2.2-rc.1'
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts.map((alert) => alert.kind)).toEqual(['degraded', 'recovered'])
    harness.lifecycle.stop()
  })
})

describe('§7.3 #6 DEGRADED 下 DSH 进程消失 → 跟随退出 dsh-degraded（0 launch、不 SIGTERM）', () => {
  it('降级时 DSH 在运行 → 进程消失 → quit(dsh-degraded)，不重启不发信号', async () => {
    const harness = await started({ running: true, dshVersion: '0.3.0' })
    expect(harness.lifecycle.getState()).toBe('DEGRADED')

    harness.process.running = false
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('CASCADING')
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-degraded')
    expect(harness.quits).toEqual(['dsh-degraded'])
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.process.terminateCalls).toEqual([])

    await harness.advance(60_000)
    expect(harness.quits).toEqual(['dsh-degraded']) // 只 quit 一次
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })

  it('UNPAIRED 下 DSH 进程消失 → 跟随退出 dsh-degraded（E3）', async () => {
    const harness = await started({ running: true, autoHandshake: false })
    expect(harness.lifecycle.getState()).toBe('UNPAIRED')

    harness.process.running = false
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getQuitReason()).toBe('dsh-degraded')
    expect(harness.quits).toEqual(['dsh-degraded'])
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.process.terminateCalls).toEqual([])
    harness.lifecycle.stop()
  })
})

describe('§7.3 #8 DEGRADED 自动恢复 PAIRED（联动语义恢复 + recovered 告警）', () => {
  it('bridge-lost 降级后桥重新上线 → 自动 PAIRED，发一次 recovered 告警', async () => {
    const harness = await pairRunning()
    await harness.feedStatus(OFFLINE_STATUS)
    await harness.advance(DSH_BRIDGE_LOST_GRACE_MS + DSH_LIFECYCLE_TICK_MS * 2)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'bridge-lost' })
    expect(harness.process.terminateCalls).toEqual([]) // 不杀 DSH

    // 桥心跳 + attached 恢复
    await harness.feedStatus(ONLINE_STATUS)
    await harness.feedControl(v4Attached(harness.scheduler.time))
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts).toHaveLength(2)
    expect(harness.alerts[1]).toMatchObject({
      kind: 'recovered',
      code: 'bridge-lost',
      state: 'PAIRED'
    })
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })
})

describe('§7.3 #9 STARTING 拉起失败 180s → DEGRADED(startup-failed)，之后不再 launch', () => {
  it('180s 内拉不起来 → DEGRADED；常驻等待，不 quit；用户手动打开 DSH 后自动 PAIRED', async () => {
    const harness = await started() // 拉起成功返回 true 但进程始终没出现（DSH 起不来）
    expect(harness.process.launchCalls).toBe(1)

    await harness.advance(DSH_STARTUP_GIVEUP_MS)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'startup-failed' })
    expect(harness.process.launchCalls).toBe(DSH_MAX_LAUNCHES_PER_WINDOW) // 3 次后放弃
    expect(harness.quits).toEqual([])

    // 之后不再无限重试
    await harness.advance(300_000)
    expect(harness.process.launchCalls).toBe(DSH_MAX_LAUNCHES_PER_WINDOW)
    expect(harness.quits).toEqual([]) // 进入降级时 DSH 未运行 → 常驻，不跟随退出

    // 用户手动打开 DSH（修复）→ 握手恢复自动回 PAIRED + recovered 告警
    await harness.pair()
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts.map((alert) => alert.kind)).toEqual(['degraded', 'recovered'])
    harness.lifecycle.stop()
  })
})

describe('§7.3 #10 PAIRED 心跳丢失 30s → DEGRADED(bridge-lost)，不杀 DSH', () => {
  it('online 心跳消失 30s → 降级；DSH 进程仍在、不 terminate、不 launch', async () => {
    const harness = await pairRunning()
    await harness.feedStatus(OFFLINE_STATUS)
    expect(harness.lifecycle.getState()).toBe('PAIRED') // 30s 宽限内保持

    await harness.advance(DSH_BRIDGE_LOST_GRACE_MS + DSH_LIFECYCLE_TICK_MS * 2)
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'bridge-lost' })
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.process.launchCalls).toBe(0)
    harness.lifecycle.stop()
  })
})

describe('§7.3 #12 safe-mode 文件 → DISABLED；不 launch/不 kill/不 cascade；删除后 tick 恢复', () => {
  it('启动时 safe-mode 生效 → DISABLED 且零动作；删除后 tick 恢复 STARTING 并拉起', async () => {
    const harness = await started({ safeMode: true })
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    expect(harness.lifecycle.isEnabled()).toBe(false)

    await harness.advance(10_000)
    expect(harness.process.launchCalls).toBe(0)
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual([])

    harness.safeMode.active = false
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('STARTING')
    expect(harness.process.launchCalls).toBe(1)
    harness.lifecycle.stop()
  })

  it('运行中开启 safe-mode → DISABLED，不杀 DSH；关闭后恢复 PAIRED', async () => {
    const harness = await pairRunning()

    harness.safeMode.active = true
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('DISABLED')
    expect(harness.lifecycle.isEnabled()).toBe(false)
    expect(harness.process.terminateCalls).toEqual([])
    expect(harness.quits).toEqual([])

    // 安全模式期间 DSH 退出也不 cascade（不跟随退出）
    harness.process.running = false
    await harness.advance(30_000)
    expect(harness.quits).toEqual([])
    expect(harness.lifecycle.getState()).toBe('DISABLED')

    // DSH 重新打开 + 删除 safe-mode → tick 恢复（缓存握手信号仍有效）
    harness.process.running = true
    harness.safeMode.active = false
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    harness.lifecycle.stop()
  })
})

describe('§7.3 #13 告警去重：同一次 DEGRADED 只告警一次；恢复一次', () => {
  it('DEGRADED 持续期间不重复告警，恢复后发 recovered，再次降级再告警一次', async () => {
    const harness = await started({ running: true, dshVersion: '0.3.0' })
    expect(harness.alerts).toHaveLength(1)
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'compat-incompatible' })

    // 持续降级 60s：每 3s 重试握手评估，但同一次 DEGRADED 不再告警
    await harness.advance(60_000)
    expect(harness.alerts).toHaveLength(1)

    // 版本探测恢复正常 → 自动回 PAIRED + 一次 recovered
    harness.dshVersion = '0.2.2-rc.1'
    await harness.advance(DSH_LIFECYCLE_TICK_MS)
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts).toHaveLength(2)
    expect(harness.alerts[1]).toMatchObject({ kind: 'recovered', code: 'compat-incompatible' })

    // 再次降级（HMR 加载了未来桥）→ 新一次 degraded 告警
    harness.dshVersion = '0.3.0'
    await harness.feedControl(v4Attached(harness.scheduler.time))
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts).toHaveLength(3)
    expect(harness.alerts[2]).toMatchObject({ kind: 'degraded', code: 'compat-incompatible' })
    harness.lifecycle.stop()
  })
})

describe('安装清单兜底（E6）：运行时 compat 缺失时用 install.json 静态判定', () => {
  it('control 帧无 compat 但安装清单声明 v4 兼容范围 → PAIRED', async () => {
    const harness = await started({
      running: true,
      autoHandshake: false,
      dirState: { installManifest: manifest(), diagnostic: null, dir: '/fake-dsh' }
    })
    await harness.feedStatus(ONLINE_STATUS)
    // v4 桥但帧里没有 compat 块（如旧帧/部分字段丢失）：控制帧 schemaVersion 已由解析器校验为 1
    await harness.feedControl({
      schemaVersion: 1,
      ts: harness.scheduler.time,
      action: 'attached',
      dshPid: 4321,
      bridgeVersion: 4
    })
    expect(harness.lifecycle.getState()).toBe('PAIRED')
    expect(harness.alerts).toEqual([])
    harness.lifecycle.stop()
  })

  it('安装清单声明范围不含当前 DSH → 立即 DEGRADED，detail 指明版本/范围', async () => {
    const harness = await started({
      running: true,
      autoHandshake: false,
      dshVersion: '0.3.0',
      dirState: { installManifest: manifest(), diagnostic: null, dir: '/fake-dsh' }
    })
    await harness.feedStatus(ONLINE_STATUS)
    await harness.feedControl({
      schemaVersion: 1,
      ts: harness.scheduler.time,
      action: 'attached',
      dshPid: 4321,
      bridgeVersion: 4
    })
    expect(harness.lifecycle.getState()).toBe('DEGRADED')
    expect(harness.alerts[0]).toMatchObject({ kind: 'degraded', code: 'compat-incompatible' })
    expect(harness.alerts[0]?.reason).toContain('0.3.0')
    expect(harness.alerts[0]?.reason).toContain(V4_RANGE)
    harness.lifecycle.stop()
  })
})

/* ------------------------------ 时钟/周期常量 ------------------------------ */

describe('契约常量', () => {
  it('v1 既有 + v2 新增常量与计划一致', () => {
    expect(DSH_LIFECYCLE_TICK_MS).toBe(3000)
    expect(DSH_CONTROL_GRACE_MS).toBe(1500)
    expect(DSH_RESTART_INTERVAL_MS).toBe(5000)
    expect(DSH_MAX_RESTARTS).toBe(2)
    expect(DSH_LAUNCH_COOLDOWN_MS).toBe(60_000)
    expect(DSH_STARTUP_GIVEUP_MS).toBe(180_000)
    expect(DSH_UNPAIRED_GRACE_MS).toBe(20_000)
    expect(DSH_BRIDGE_LOST_GRACE_MS).toBe(30_000)
  })
})
