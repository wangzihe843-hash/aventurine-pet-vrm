/**
 * 桌宠 ⇄ DeepSeek Harness 强耦合生命周期状态机（Wave 3 A3 + 2026-11-11 兼容性安全 v2）。
 *
 * 契约依据：`docs/wave3-dsh-integration-design.md` §4.1 +
 * `docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §2/§6.2（用户 2026-11-11 拍板的「强耦合」语义）：
 * 1. **互保活**：桌宠启动时若 DSH 不在运行 → `launch()` 拉起；
 * 2. **同生共死**：
 *    - 桌宠显式退出（`before-quit`）→ **仅当握手健康（PAIRED）** 才先 SIGTERM（≤5s 后 SIGKILL）
 *      DSH 再退出；`UNPAIRED`/`DEGRADED`/`DISABLED` 放行（绝不杀 DSH —— 给"打开 DSH 修桌宠"留活口）；
 *    - DSH **显式退出**（桥 dispose 写 `detached` 且进程不在）→ 桌宠跟随退出（`dsh-exit`），**绝不重启**；
 *    - DSH **崩溃**（无 `detached` 的进程消失）→ 先按降温策略重启 ≤2 次（间隔 5s），
 *      仍失败 → `DEGRADED(crash-recovery-failed)` 常驻（**不再级联自杀**，等用户修好 DSH）；
 * 3. **HMR 竞态**：detached 后 1.5s grace；期间 attached 取消；grace 后按进程探测裁决；
 * 4. **握手门槛（v2 新增，核心安全语义）**：`PAIRED` 必须同时满足
 *    ① DSH 进程在运行；② `status.online` 心跳新鲜（30s TTL）；③ `control.json` 最近帧 attached
 *    且未被 detached 覆盖；④ 兼容判定通过（运行时 compat / v3 legacy 回退 / 安装清单静态判定）。
 *    陈旧 control/status 不得进 `PAIRED`（否则"上次会话遗留的 attached"会造成假联动 + 误重启 DSH）。
 * 5. **降级语义（v2 新增）**：
 *    - `STARTING` 拉起失败限时 `DSH_STARTUP_GIVEUP_MS`（180s）→ `DEGRADED(startup-failed)`；
 *    - DSH 在跑但握手不健康 → `UNPAIRED`，20s 超时 → `DEGRADED(no-bridge-unpaired|compat-unverified)`；
 *    - compat 明确不兼容 → 立即 `DEGRADED(compat-incompatible)`；
 *    - `PAIRED` 后心跳/control 丢失 30s → `DEGRADED(bridge-lost)`；崩溃重启次数用尽 →
 *      `DEGRADED(crash-recovery-failed)`；
 *    - `DEGRADED` 下**禁止**拉起/重启/终止 DSH；DSH 进程消失 → 跟随退出（`dsh-degraded`，
 *      不重启不发信号）；握手恢复 → 自动回 `PAIRED`（联动语义恢复）；
 * 6. **安全模式（v2 新增）**：注入 `isSafeMode()`（生产 = `~/.dsh/aventurine-pet/safe-mode` 文件存在），
 *    为真视同耦合关闭（每 tick 重查，可热生效/热失效），优先级高于 config、低于
 *    `PET_DSH_COUPLING_DISABLE=1`；
 * 7. **告警（v2 新增）**：进入 `DEGRADED` 一次 / 恢复 `PAIRED` 一次触发 `onCouplingAlert`；
 *    `DEGRADED` 期间不重复告警（ipc 层负责"同原因只弹一次 modal"与静默 env）；
 * 8. **防互杀环**：`quitReason`/`dshTerminatedByPet`/`CASCADING` 三个标记保证
 *    「桌宠因 DSH 退出而退出」时不再向 DSH 发信号；
 * 9. **dev 安全**：未打包（`!app.isPackaged`）时必须显式 `PET_DSH_COUPLING=1` 才启用；
 *    `PET_DSH_COUPLING_DISABLE=1` 在任何构建下强制关闭（防开发/测试误杀真实 DSH）。
 *
 * 本模块**不 import electron / fs / child_process**：DSH 进程操作、配置读取、定时器、
 * 时钟、quit 动作、DSH 版本探测、桥目录状态、安全模式、告警全部由调用方（`src/main/ipc/dsh.ts`）注入，
 * 单测可完全离线。所有公开方法保证「绝不抛」。
 *
 * 状态机（`DshLifecycleState`）：
 * ```
 * DISABLED ──config/env/safe-mode on──► STARTING
 *   ▲                                     │ 握手健康（四门槛）──► PAIRED
 *   │                                     │ DSH 运行但握手不健康 ─► UNPAIRED（20s 超时）
 *   │                                     │ 拉起失败 180s ───────► DEGRADED(startup-failed)
 *   │                                     │ compat 明确不兼容 ───► DEGRADED(compat-incompatible)
 *   │                                     ▼
 *   │                                  UNPAIRED ──握手健康──► PAIRED
 *   │                                     │ 20s 超时 → DEGRADED(no-bridge-unpaired|compat-unverified)
 *   │                                     │ DSH 进程消失 → CASCADING(dsh-degraded)
 *   │
 *   │                                  DEGRADED ──握手健康──► PAIRED（自动恢复 + recovered 告警）
 *   │                                     │ DSH 进程消失 → CASCADING(dsh-degraded，不重启不发信号)
 *   │                                     │ before-quit → 放行（不杀 DSH）
 *   │
 *   └────────────┬──────────────────── PAIRED ──DSH 进程消失──► 确认窗口（grace）
 *                │                                              │ detached → CASCADING(dsh-exit)
 *                │                                              │ 无 detached → 重启 ≤2 次
 *                │                                              │ 仍失败 → DEGRADED(crash-recovery-failed)
 *                │                       心跳/control 丢失 30s ─► DEGRADED(bridge-lost)
 *              config/env off / stop
 * ```
 */
import { BRIDGE_LEGACY_DSH_RANGE, parseDshBridgeCompat } from '@shared/bridge-schema'
import type { DshBridgeCompat, DshBridgeControlFile } from '@shared/bridge-schema'
import type { DshStatus } from '@shared/types'

import type { BridgeDirState } from './dsh-bridge-state'
import { evaluateCouplingCompat } from './dsh-compat'
import type { CouplingCompatResult } from './dsh-compat'
import type { DshProcess } from './dsh-process'

/** 日志前缀（`main.log` 便于排障）。 */
const LOG_PREFIX = '[dsh-lifecycle]'

/** 状态快照轮询周期（契约 §4.1：3s）。 */
export const DSH_LIFECYCLE_TICK_MS = 3000

/** control detached 后等待重新 attached 的 grace（契约 §3.2：1500ms）。 */
export const DSH_CONTROL_GRACE_MS = 1500

/** 崩溃重启两次尝试之间的验证间隔（契约 §4.1：≤2 次 / 5s 间隔）。 */
export const DSH_RESTART_INTERVAL_MS = 5000

/** 崩溃后最多重启次数（含第一次；仍失败 → DEGRADED，不自杀）。 */
export const DSH_MAX_RESTARTS = 2

/** STARTING 状态拉起 DSH 的冷却（契约 §4.1：60s）。 */
export const DSH_LAUNCH_COOLDOWN_MS = 60_000

/** STARTING 拉起次数窗口（契约 §4.1：最多 3 次/90s）。 */
export const DSH_LAUNCH_WINDOW_MS = 90_000

/** STARTING 状态窗口内最多拉起次数。 */
export const DSH_MAX_LAUNCHES_PER_WINDOW = 3

/**
 * STARTING 拉起失败的总宽限（v2）：3 次/90s 限流用尽后再等 90s，共约 180s；
 * 进程仍不在运行 → `DEGRADED(startup-failed)`，不再无限重试。
 */
export const DSH_STARTUP_GIVEUP_MS = 180_000

/** DSH 在运行但握手不健康（UNPAIRED）的超时（v2）：超时 → DEGRADED。 */
export const DSH_UNPAIRED_GRACE_MS = 20_000

/** PAIRED 后心跳/control 丢失超过该时长 → DEGRADED(bridge-lost)（v2）。 */
export const DSH_BRIDGE_LOST_GRACE_MS = 30_000

/** dev（未打包）启用强耦合必须显式设置的 env（防误杀真实 DSH）。 */
export const PET_DSH_COUPLING_ENV = 'PET_DSH_COUPLING'

/** 任何构建下无条件禁用强耦合的 env（测试/排障/用户强制关闭）。 */
export const PET_DSH_COUPLING_DISABLE_ENV = 'PET_DSH_COUPLING_DISABLE'

/** 耦合状态机状态（v2 新增 `UNPAIRED`/`DEGRADED`）。 */
export type DshLifecycleState =
  | 'DISABLED'
  | 'STARTING'
  | 'UNPAIRED'
  | 'PAIRED'
  | 'DEGRADED'
  | 'CASCADING'

/**
 * 退出原因（内部防环标记；`dsh-gone`/`dsh-exit`/`dsh-degraded` 都表示因 DSH 退出而退出，
 * 绝不再向 DSH 发信号）：
 * - `dsh-exit`：桥 detached 经 grace 确认（DSH 显式退出 / 桥被卸载）；
 * - `dsh-gone`：进程探测发现 DSH 消失（崩溃/被杀）且重启失败；
 * - `dsh-degraded`：`UNPAIRED`/`DEGRADED` 下 DSH 进程消失 → 跟随退出（不重启不发信号）；
 * - `pet-exit`：桌宠先终止 DSH 再退出。
 */
export type DshQuitReason = 'pet-exit' | 'dsh-gone' | 'dsh-exit' | 'dsh-degraded'

/** 恢复（重启）原因：进程消失 或 control detached 且 grace 内未重新 attached。 */
export type DshRecoveryReason = 'process-gone' | 'detached'

/**
 * 进入 DEGRADED 的内部原因码（比告警原因码更细：`compat-incompatible` 覆盖 4 种 compat code，
 * `no-bridge-unpaired` 在告警里折成 `bridge-not-loaded`）。
 */
export type DshDegradedReason =
  | 'compat-incompatible'
  | 'compat-unverified'
  | 'no-bridge-unpaired'
  | 'bridge-lost'
  | 'startup-failed'
  | 'crash-recovery-failed'

/** 告警原因码（计划 §2.4 冻结形状）。 */
export type DshCouplingAlertCode =
  | 'compat-incompatible'
  | 'compat-unverified'
  | 'bridge-not-loaded'
  | 'bridge-lost'
  | 'startup-failed'
  | 'crash-recovery-failed'

/** 耦合告警（进入 DEGRADED / 恢复 PAIRED；计划 §2.4 冻结形状）。 */
export interface DshCouplingAlert {
  kind: 'degraded' | 'recovered'
  code: DshCouplingAlertCode
  /** 人类可读一句原因；不含路径细节时也写日志。 */
  reason: string
  /** 当前 DSH 版本（读不到 → null；ipc 层可再兜底探测）。 */
  dshVersion: string | null
  /** 当前桥版本（运行 compat / control 顶层 / 安装清单兜底；未知 → null）。 */
  bridgeVersion: number | null
  /** 桥声明的 DSH 范围（v3 legacy 回退后的值；未知 → null）。 */
  dshRange: string | null
  /** 告警发生后的状态（degraded → DEGRADED；recovered → PAIRED）。 */
  state: DshLifecycleState
}

/** DEGRADED 内部原因 → 告警原因码。 */
const DEGRADED_ALERT_CODE: Record<DshDegradedReason, DshCouplingAlertCode> = {
  'compat-incompatible': 'compat-incompatible',
  'compat-unverified': 'compat-unverified',
  'no-bridge-unpaired': 'bridge-not-loaded',
  'bridge-lost': 'bridge-lost',
  'startup-failed': 'startup-failed',
  'crash-recovery-failed': 'crash-recovery-failed'
}

/** 注入的最小日志接口（与 `src/main/logger.ts` 的 Logger 结构兼容）。 */
export interface DshLifecycleLogger {
  debug?(message: string, meta?: unknown): void
  info?(message: string, meta?: unknown): void
  warn?(message: string, meta?: unknown): void
  error?(message: string, meta?: unknown): void
}

/** 可注入定时器（默认全局 setInterval/setTimeout + unref；单测注入假调度器）。 */
export interface DshLifecycleTimers {
  setInterval(callback: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

/** `before-quit` 事件的最小形状（Electron 的 `Event` 有 preventDefault）。 */
export interface DshQuitEvent {
  preventDefault(): void
}

/** 生命周期需要的配置切片（结构兼容 `PetConfig`，便于单测用普通对象）。 */
export interface DshCouplingConfig {
  dshCoupling?: boolean
}

/** `createDshLifecycle` 选项（除 process/getConfig/isPackaged 外全部有默认值）。 */
export interface CreateDshLifecycleOptions {
  /** DSH 进程控制器（真实实现见 `dsh-process.ts`；单测注入 fake）。 */
  process: DshProcess
  /** 读取当前生效配置（`getActiveConfig`）；每次 tick/退出决策都会重新读取，支持热更。 */
  getConfig: () => DshCouplingConfig
  /** 是否打包版（false = dev，必须叠加 `PET_DSH_COUPLING=1`）。 */
  isPackaged: boolean
  /** 环境变量源（默认 `process.env`）。 */
  env?: NodeJS.ProcessEnv
  /** 日志接口（默认静默）。 */
  logger?: DshLifecycleLogger
  /** 时间源（默认 Date.now；单测注入假时钟）。 */
  now?: () => number
  /** 定时器（默认全局；单测注入手动调度器）。 */
  timers?: DshLifecycleTimers
  /** 级联退出/终止 DSH 后请求桌宠退出的动作（生产 = `app.quit`；单测 fake）。 */
  quit?: (reason: DshQuitReason) => void
  /** 状态快照周期（默认 3000）。 */
  tickMs?: number
  /** detached grace（默认 1500）。 */
  graceMs?: number
  /** 重启验证间隔（默认 5000）。 */
  restartIntervalMs?: number
  /** 崩溃重启上限（默认 2，含第一次）。 */
  maxRestarts?: number
  /** STARTING 拉起冷却（默认 60000）。 */
  launchCooldownMs?: number
  /** STARTING 拉起窗口（默认 90000）。 */
  launchWindowMs?: number
  /** STARTING 窗口内拉起上限（默认 3）。 */
  maxLaunchesPerWindow?: number
  /** STARTING 拉起失败总宽限（默认 180000；0/负数 → 默认值）。 */
  startupGiveupMs?: number
  /** UNPAIRED 超时（默认 20000）。 */
  unpairedGraceMs?: number
  /** PAIRED 桥信号丢失宽限（默认 30000）。 */
  bridgeLostGraceMs?: number
  /** 读取 DSH app 版本（生产 = `dsh-version.ts` 探测器）；未注入 → 视为版本未知。 */
  getDshVersion?: () => Promise<string | null>
  /** 读取桥目录静态状态（install.json / bridge-error.json）；未注入 → 空状态。 */
  readBridgeDirState?: () => BridgeDirState
  /** 进入 DEGRADED / 恢复 PAIRED 的告警回调（ipc 层实现 dialog/Notification/日志）。 */
  onCouplingAlert?: (alert: DshCouplingAlert) => void
  /** 安全模式检查（生产 = safe-mode 文件存在）；默认关闭。每 tick 重查。 */
  isSafeMode?: () => boolean
}

/** 对外 API（IPC 层与单测只依赖本接口）。 */
export interface DshLifecycle {
  /** 当前状态（测试/排障用）。 */
  getState(): DshLifecycleState
  /** 当前是否启用耦合（按最近一次配置/env/safe-mode 求值）。 */
  isEnabled(): boolean
  /** 退出原因（未退出为 null）。 */
  getQuitReason(): DshQuitReason | null
  /** 启动：进入 STARTING 并开始 3s tick（幂等）。 */
  start(): void
  /** 停止：清空全部定时器，不再触发任何动作（幂等；不终止 DSH）。 */
  stop(): void
  /** 配置热更：重新求值启用状态（启用→STARTING；禁用→DISABLED）。 */
  refreshConfig(): void
  /** 一次状态快照（生产由 tick 定时器调用；公开便于单测确定性驱动）。 */
  tick(): Promise<void>
  /** 处理桥 control 帧（attached/detached；attached 会触发握手评估，detached 走 1.5s grace）。 */
  handleControl(frame: DshBridgeControlFile): void
  /** 处理桥 status 心跳（记录 online 新鲜度并触发握手评估；不再单独进 PAIRED）。 */
  handleStatus(status: DshStatus): void
  /** 处理桌宠 `before-quit`：仅 PAIRED 且握手健康时 preventDefault → SIGTERM DSH → 再 quit。 */
  handleBeforeQuit(event: DshQuitEvent): void
}

/** 默认定时器：全部 `unref`，不阻止 app 退出（Electron 有窗口/tray 保活）。 */
function createDefaultTimers(): DshLifecycleTimers {
  return {
    setInterval(callback, ms) {
      const handle = setInterval(callback, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clearInterval(handle) {
      clearInterval(handle as ReturnType<typeof setInterval>)
    },
    setTimeout(callback, ms) {
      const handle = setTimeout(callback, ms)
      ;(handle as { unref?: () => void }).unref?.()
      return handle
    },
    clearTimeout(handle) {
      clearTimeout(handle as ReturnType<typeof setTimeout>)
    }
  }
}

/**
 * 判断强耦合是否启用（纯函数，契约 §4.1 dev 安全条款）。
 *
 * 规则（按优先级）：
 * 1. `PET_DSH_COUPLING_DISABLE === '1'` → 关闭（任何构建，最高优先）；
 * 2. `config.dshCoupling === false` → 关闭（缺省/undefined 视为默认 true）；
 * 3. 打包版（`isPackaged === true`）→ 启用；
 * 4. dev（未打包）→ 仅当 `PET_DSH_COUPLING === '1'` 时启用（防开发调试误杀正在使用的 DSH）。
 *
 * 注意：安全模式（`safe-mode` 文件）由生命周期每 tick 单独检查，不折进本纯函数
 * （本函数保持"配置/env"语义，安全模式优先级高于 config、低于 DISABLE）。
 */
export function isDshCouplingEnabled(input: {
  config?: DshCouplingConfig
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): boolean {
  const env = input.env ?? process.env
  if (env[PET_DSH_COUPLING_DISABLE_ENV] === '1') return false
  if (input.config?.dshCoupling === false) return false
  if (input.isPackaged === true) return true
  return env[PET_DSH_COUPLING_ENV] === '1'
}

/** 恢复流程内部状态。 */
interface RecoveryState {
  reason: DshRecoveryReason
  /** 已发起重启次数（含当前这次）。 */
  attempts: number
  /** 当前这次重启的「等 5s 后验证」定时器。 */
  verifyHandle: unknown | null
  /** 发起恢复前的 attached 时间（detached 恢复要求出现新的 attached 才算成功）。 */
  attachedBefore: number | null
}

/** 空桥目录状态（未注入 readBridgeDirState 时使用）。 */
const EMPTY_BRIDGE_STATE: BridgeDirState = {
  installManifest: null,
  diagnostic: null,
  dir: ''
}

/** 把 unknown 异常压成一行可读文本。 */
function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/** 归一化桥版本（合法的正安全整数才保留，否则 null）。 */
function normalizeBridgeVersion(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return null
  return value
}

/**
 * 创建强耦合生命周期状态机（单例，由 `ipc/dsh.ts` 创建并 `start()`）。
 *
 * 所有公开方法都保证「绝不抛」：配置读取/进程探测/版本探测/quit/告警回调异常只写日志并降级，
 * 不允许耦合逻辑反过来破坏桌宠主流程（契约 §4.1：失败只 log，不弹窗）。
 */
export function createDshLifecycle(options: CreateDshLifecycleOptions): DshLifecycle {
  const dshProcess = options.process
  const getConfig = options.getConfig
  const isPackaged = options.isPackaged === true
  const env = options.env ?? process.env
  const logger = options.logger
  const now = options.now ?? ((): number => Date.now())
  const timers = options.timers ?? createDefaultTimers()
  const quit = options.quit
  const tickMs = normalizePositive(options.tickMs, DSH_LIFECYCLE_TICK_MS)
  const graceMs = normalizePositive(options.graceMs, DSH_CONTROL_GRACE_MS)
  const restartIntervalMs = normalizePositive(options.restartIntervalMs, DSH_RESTART_INTERVAL_MS)
  const maxRestarts = normalizePositive(options.maxRestarts, DSH_MAX_RESTARTS)
  const launchCooldownMs = normalizePositive(options.launchCooldownMs, DSH_LAUNCH_COOLDOWN_MS)
  const launchWindowMs = normalizePositive(options.launchWindowMs, DSH_LAUNCH_WINDOW_MS)
  const maxLaunchesPerWindow = normalizePositive(
    options.maxLaunchesPerWindow,
    DSH_MAX_LAUNCHES_PER_WINDOW
  )
  const startupGiveupMs = normalizePositive(options.startupGiveupMs, DSH_STARTUP_GIVEUP_MS)
  const unpairedGraceMs = normalizePositive(options.unpairedGraceMs, DSH_UNPAIRED_GRACE_MS)
  const bridgeLostGraceMs = normalizePositive(options.bridgeLostGraceMs, DSH_BRIDGE_LOST_GRACE_MS)
  const getDshVersion =
    options.getDshVersion ?? ((): Promise<string | null> => Promise.resolve(null))
  const readBridgeDirState =
    options.readBridgeDirState ?? ((): BridgeDirState => EMPTY_BRIDGE_STATE)
  const onCouplingAlert = options.onCouplingAlert
  const isSafeMode = options.isSafeMode ?? ((): boolean => false)

  /** 当前状态；初始为 DISABLED，`start()`/`refreshConfig()` 时按配置求值。 */
  let state: DshLifecycleState = 'DISABLED'
  /** 最近一次成功求值的启用状态（配置 getter 抛错时沿用，保持行为稳定）。 */
  let enabled = false
  /** 是否已 start（幂等保护）。 */
  let started = false
  /** 是否已 stop（之后所有动作短路）。 */
  let stopped = false
  /** 3s tick 定时器。 */
  let tickHandle: unknown | null = null
  /** detached grace 定时器。 */
  let graceHandle: unknown | null = null
  /**
   * 是否收到过 `detached` 且尚未收到新的 `attached`（桥没了：DSH 退出 / HMR / 插件卸载）。
   * 置位期间视为「显式退出候选」：进程消失 → 跟随退出（dsh-exit），**绝不重启**。
   * v2 起同时作为握手健康第 3 项（control 未 attached）。
   */
  let bridgeDetached = false
  /**
   * PAIRED 下探测到进程消失后的「显式退出 / 崩溃」确认定时器（null = 无）。
   * 复用 detached grace 时长：等 watcher 把可能的 `detached` 帧读进来再决定是否重启。
   */
  let exitConfirmHandle: unknown | null = null
  /** 「detached 后进程仍在运行，保持等待」只记一次日志（避免 3s tick 刷屏）。 */
  let detachedWaitLogged = false
  /** 当前恢复流程（null = 未在恢复）。 */
  let recovery: RecoveryState | null = null
  /** STARTING 状态拉起历史（毫秒时间戳；用于 60s 冷却 + 3 次/90s 限流）。 */
  let launchHistory: number[] = []
  /** 最近一次进程探测结果（null = 尚未探测；用于 before-quit 快速放行）。 */
  let lastKnownRunning: boolean | null = null
  /** 最近一次 bridge attached 的 ts（detached 恢复的成功判据）。 */
  let attachedAt: number | null = null
  /** 退出原因（null = 未在退出）。 */
  let quitReason: DshQuitReason | null = null
  /** 是否已调用过 quit（避免重复 app.quit）。 */
  let quitSent = false
  /** 是否正在执行「退出前终止 DSH」流程。 */
  let quitFlowInProgress = false
  /** 是否已由桌宠主动终止 DSH（之后 DSH 消失不再重启/不再发信号）。 */
  let dshTerminatedByPet = false
  /**
   * 退出握手是否已完成：`finishQuit()` 后再次触发的 before-quit 必须放行，
   * 否则「SIGTERM 后 app.quit()」的第二次事件会被再次 preventDefault 造成卡死。
   */
  let petQuitPrepared = false
  /** 配置 getter 异常只 warn 一次。 */
  let configWarned = false
  /** 安全模式检查异常 / 生效日志只记一次。 */
  let safeModeWarned = false
  let safeModeLogged = false
  /** 版本探测异常只 warn 一次。 */
  let versionWarned = false
  /** 防止异步 tick 重入。 */
  let ticking = false

  /* ---------------------------- v2 握手/降级状态 ---------------------------- */

  /** 最近一次 status 心跳是否 online（watcher 的 30s TTL 折算结果）。 */
  let lastStatusOnline = false
  /** `control.json` 最近帧是否 attached（未被 detached 覆盖。与 !bridgeDetached 配合）。 */
  let controlAttached = false
  /** control 帧的运行时 compat 块（v4+；v3/缺失 → null）。 */
  let controlCompat: DshBridgeCompat | null = null
  /** control 帧的桥版本（compat 优先，其次顶层 bridgeVersion；未知 → null）。 */
  let controlBridgeVersion: number | null = null
  /** 最近一次成功读取的 DSH 版本（用于告警/排障；读不到 → null）。 */
  let lastDshVersion: string | null = null
  /** 最近一次读取的安装清单（告警 detail 用）。 */
  let installManifest: BridgeDirState['installManifest'] = null
  /** 最近一次读取的桥故障诊断（UNPAIRED/DEGRADED detail 用）。 */
  let bridgeDiagnostic: BridgeDirState['diagnostic'] = null
  /** 最近一次兼容判定结果（UNPAIRED 超时归因用）。 */
  let lastCompat: CouplingCompatResult | null = null
  /** 进入 UNPAIRED 的时间（null = 不在 UNPAIRED 计时）。 */
  let unpairedSince: number | null = null
  /** 进入 DEGRADED 的时间（null = 不在 DEGRADED）。 */
  let degradedSince: number | null = null
  /** PAIRED 下桥信号（心跳/control）丢失的起始时间（null = 健康）。 */
  let bridgeUnhealthySince: number | null = null
  /** STARTING 首次拉起时间（拉起失败限时 180s 的起点）。 */
  let firstLaunchAt: number | null = null
  /** 本次 DEGRADED 的告警信息（恢复时发 recovered 用）。 */
  let degradedAlert: { code: DshCouplingAlertCode; detail: string } | null = null
  /**
   * DEGRADED 期间是否观察过 DSH 运行（决定"进程消失是否跟随退出"）：
   * - 进入 DEGRADED 时 DSH 在运行（compat 不兼容 / bridge-lost）→ 之后消失 = 真实退出，跟随退出；
   * - 进入 DEGRADED 时 DSH 已不在运行（startup-failed / crash-recovery-failed）→ **保持常驻**，
   *   等用户手动打开 DSH 修复（打开后握手恢复自动回 PAIRED），不因"已经不在"而立即自杀退出，
   *   否则"降级常驻等修复"的语义自相矛盾（计划 §2.2 与 §7.3 #11 的调和）。
   */
  let degradedSawRunning = false
  /** DEGRADED 常驻等待日志只记一次。 */
  let degradedWaitLogged = false
  /** 异步握手评估串行队列（tick 与 control/status 回调都走这里，避免并发乱序）。 */
  let handshakeQueue: Promise<void> = Promise.resolve()

  /** 归一化正整数选项（非法 → 默认值）。 */
  function normalizePositive(value: number | undefined, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
    return Math.floor(value)
  }

  /** 写日志（logger 异常隔离，绝不影响状态机）。 */
  function log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
    try {
      logger?.[level]?.(`${LOG_PREFIX} ${message}`, meta)
    } catch {
      // 日志失败不影响生命周期流程
    }
  }

  /** 退出流程是否已开始（终止 DSH 中 / 已终止 / 握手完成）→ 不得再拉起或重启 DSH。 */
  function quitting(): boolean {
    return quitFlowInProgress || dshTerminatedByPet || petQuitPrepared
  }

  /** 是否处于「不做握手评估」的状态（已停止 / CASCADING / DISABLED）。 */
  function inert(): boolean {
    return stopped || state === 'CASCADING' || state === 'DISABLED'
  }

  /** 读取配置切片；异常 → 沿用最近一次启用状态。 */
  function readConfig(): DshCouplingConfig {
    try {
      return getConfig() ?? {}
    } catch (error) {
      if (!configWarned) {
        configWarned = true
        log('warn', `读取配置失败，沿用上次启用状态 enabled=${String(enabled)}`, {
          error: errorText(error)
        })
      }
      return { dshCoupling: enabled }
    }
  }

  /** 读取安全模式（异常 → 视为关闭并只 warn 一次；安全模式失效不应反过来影响主流程）。 */
  function readSafeMode(): boolean {
    try {
      return isSafeMode() === true
    } catch (error) {
      if (!safeModeWarned) {
        safeModeWarned = true
        log('warn', `安全模式检查失败，按未开启处理: ${errorText(error)}`)
      }
      return false
    }
  }

  /** 重新求值启用状态（config/env + 安全模式；不改变定时器，只更新 `enabled` 变量）。 */
  function evaluateEnabled(): boolean {
    if (!isDshCouplingEnabled({ config: readConfig(), isPackaged, env })) {
      safeModeLogged = false
      return false
    }
    if (readSafeMode()) {
      if (!safeModeLogged) {
        safeModeLogged = true
        log('warn', '检测到安全模式（safe-mode）：视同耦合关闭，不拉起/不重启/不终止/不跟随 DSH')
      }
      return false
    }
    safeModeLogged = false
    return true
  }

  /** 清 tick 定时器。 */
  function clearTick(): void {
    if (tickHandle !== null) {
      timers.clearInterval(tickHandle)
      tickHandle = null
    }
  }

  /** 清 grace 定时器。 */
  function clearGrace(): void {
    if (graceHandle !== null) {
      timers.clearTimeout(graceHandle)
      graceHandle = null
    }
  }

  /** 清「进程消失确认」定时器（取消待定的显式退出/崩溃判定）。 */
  function clearExitConfirm(): void {
    if (exitConfirmHandle !== null) {
      timers.clearTimeout(exitConfirmHandle)
      exitConfirmHandle = null
    }
  }

  /** 取消恢复流程（若存在），清验证定时器。 */
  function cancelRecovery(reason: string): void {
    if (!recovery) return
    if (recovery.verifyHandle !== null) {
      timers.clearTimeout(recovery.verifyHandle)
      recovery.verifyHandle = null
    }
    log('info', `取消重启恢复（${reason}）`, { attempts: recovery.attempts })
    recovery = null
  }

  /** 清空所有「操作类」定时器（tick/grace/恢复验证/进程消失确认）。 */
  function clearOperationalTimers(): void {
    clearGrace()
    clearExitConfirm()
    cancelRecovery('timers-cleared')
  }

  /** 重置「等待类」计时（进入 PAIRED/DISABLED 或重新启用时用）。 */
  function resetWaitingTracking(): void {
    unpairedSince = null
    bridgeUnhealthySince = null
    firstLaunchAt = null
    degradedSince = null
    launchHistory = []
  }

  /** 探测 DSH 进程；异常 → false（按「不在运行」降级），并缓存结果。 */
  async function probeRunning(): Promise<boolean> {
    try {
      const running = await dshProcess.isRunning()
      lastKnownRunning = running
      return running
    } catch (error) {
      log('warn', `进程探测失败，按未运行处理: ${errorText(error)}`)
      lastKnownRunning = false
      return false
    }
  }

  /* ------------------------------ 握手评估 ------------------------------ */

  /** 当前握手四门槛前三项（进程由调用方探测；compat 见 evaluateHandshake）。 */
  function handshakeFactorsHealthy(): boolean {
    return lastStatusOnline && controlAttached && !bridgeDetached
  }

  /** 组装告警里的版本/范围上下文（运行时优先，安装清单兜底；v3 回退 legacy 范围）。 */
  function alertContext(): Pick<DshCouplingAlert, 'dshVersion' | 'bridgeVersion' | 'dshRange'> {
    const bridgeVersion =
      controlCompat?.bridgeVersion ?? controlBridgeVersion ?? installManifest?.bridgeVersion ?? null
    let dshRange: string | null = controlCompat?.dshRange ?? null
    if (dshRange === null && bridgeVersion === 3) dshRange = BRIDGE_LEGACY_DSH_RANGE
    if (dshRange === null) dshRange = installManifest?.dshRange ?? null
    return { dshVersion: lastDshVersion, bridgeVersion, dshRange }
  }

  /** 触发告警回调（异常隔离：告警失败不能影响生命周期）。 */
  function emitCouplingAlert(alert: DshCouplingAlert): void {
    try {
      onCouplingAlert?.(alert)
    } catch (error) {
      log('warn', `耦合告警回调异常: ${errorText(error)}`)
    }
  }

  /** 进入 PAIRED（从任何非 CASCADING/DISABLED 状态；DEGRADED 恢复时发 recovered 告警）。 */
  function enterPaired(reason: string): void {
    if (state === 'PAIRED' || state === 'CASCADING' || state === 'DISABLED') return
    const recoveredFrom = state === 'DEGRADED' ? degradedAlert : null
    state = 'PAIRED'
    clearGrace()
    clearExitConfirm()
    cancelRecovery('enter-paired')
    resetWaitingTracking()
    degradedAlert = null
    log('info', `进入 PAIRED（${reason}）`, {
      attachedAt,
      bridgeVersion: controlCompat?.bridgeVersion ?? controlBridgeVersion,
      dshVersion: lastDshVersion
    })
    if (recoveredFrom) {
      emitCouplingAlert({
        kind: 'recovered',
        code: recoveredFrom.code,
        reason: `握手恢复，联动语义恢复（此前降级原因：${recoveredFrom.detail}）`,
        ...alertContext(),
        state: 'PAIRED'
      })
    }
  }

  /** 进入 UNPAIRED（仅 STARTING/PAIRED 可进入；DSH 在运行但四门槛未同时成立）。 */
  function enterUnpaired(reason: string): void {
    if (state === 'UNPAIRED' || state === 'CASCADING' || state === 'DISABLED') return
    state = 'UNPAIRED'
    unpairedSince = now()
    bridgeUnhealthySince = null
    clearGrace()
    clearExitConfirm()
    cancelRecovery('enter-unpaired')
    log('warn', `DSH 在运行但握手不健康（${reason}），进入 UNPAIRED，等待握手 ${unpairedGraceMs}ms`, {
      lastStatusOnline,
      controlAttached,
      bridgeDetached,
      bridgeVersion: controlCompat?.bridgeVersion ?? controlBridgeVersion,
      dshVersion: lastDshVersion
    })
  }

  /** 进入 DEGRADED（进入即发一次 degraded 告警；DEGRADED 期间重复调用被忽略）。 */
  function enterDegraded(reason: DshDegradedReason, detail: string): void {
    if (
      stopped ||
      state === 'CASCADING' ||
      state === 'DISABLED' ||
      state === 'DEGRADED'
    ) {
      return
    }
    state = 'DEGRADED'
    degradedSince = now()
    degradedAlert = { code: DEGRADED_ALERT_CODE[reason], detail }
    degradedSawRunning = lastKnownRunning === true
    degradedWaitLogged = false
    unpairedSince = null
    bridgeUnhealthySince = null
    firstLaunchAt = null
    clearOperationalTimers()
    const alert = {
      kind: 'degraded' as const,
      code: DEGRADED_ALERT_CODE[reason],
      reason: detail,
      ...alertContext(),
      state: 'DEGRADED' as const
    }
    log('warn', `进入 DEGRADED（${reason}）：${detail}`, {
      degradedSince,
      lastStatusOnline,
      controlAttached,
      bridgeDetached,
      dshVersion: lastDshVersion
    })
    emitCouplingAlert(alert)
  }

  /** 组装「桥握手恢复中」的兼容判定输入并求值（纯函数；输入异常时降级为 unverified）。 */
  function evaluateCompat(): CouplingCompatResult {
    return evaluateCouplingCompat({
      dshVersion: lastDshVersion,
      bridgeVersion: controlCompat?.bridgeVersion ?? controlBridgeVersion ?? null,
      controlSchema: controlCompat?.controlSchema ?? null,
      dshRange: controlCompat?.dshRange ?? null,
      installManifest
    })
  }

  /** 读取桥目录静态状态（install.json / bridge-error.json；mtime 缓存、异常降级、绝不抛）。 */
  function refreshBridgeDirState(): void {
    try {
      const dirState = readBridgeDirState() ?? EMPTY_BRIDGE_STATE
      installManifest = dirState.installManifest ?? null
      bridgeDiagnostic = dirState.diagnostic ?? null
    } catch (error) {
      log('warn', `读取桥目录状态失败（按无信号处理）: ${errorText(error)}`)
      installManifest = null
      bridgeDiagnostic = null
    }
  }

  /**
   * 一次完整握手评估（async：可能读 DSH 版本）——**唯一的 PAIRED/DEGRADED 判定入口**。
   *
   * 前置：进程在运行、status online、control attached 且未 detached（否则直接返回，
   * 交给状态专属 tick 处理 UNPAIRED/进程消失等分支）。
   */
  async function runHandshakeEvaluation(): Promise<void> {
    if (inert()) return
    const running = await probeRunning()
    if (inert() || !running) return
    if (!handshakeFactorsHealthy()) return

    // 1) DSH 版本（探测器自带 60s 缓存；失败 → null = 不可验证，不猜兼容）。
    let dshVersion: string | null = null
    try {
      const detected = await getDshVersion()
      dshVersion = typeof detected === 'string' && detected.trim().length > 0 ? detected.trim() : null
    } catch (error) {
      if (!versionWarned) {
        versionWarned = true
        log('warn', `DSH 版本探测失败（按不可验证处理）: ${errorText(error)}`)
      }
      dshVersion = null
    }
    lastDshVersion = dshVersion

    // 2) 桥目录静态状态（install.json / bridge-error.json；mtime 缓存，便宜）。
    refreshBridgeDirState()

    // 3) 兼容判定（运行时 compat 优先；v3 legacy 回退；安装清单兜底）。
    const compat = evaluateCompat()
    lastCompat = compat

    if (inert()) return
    if (compat.status === 'ok') {
      bridgeUnhealthySince = null
      unpairedSince = null
      if (state === 'STARTING' || state === 'UNPAIRED' || state === 'DEGRADED') {
        enterPaired(`handshake:${compat.code}`)
      }
      return
    }
    if (compat.status === 'incompatible') {
      // 明确不兼容 → 立即降级（STARTING/UNPAIRED/PAIRED 通用）。
      enterDegraded('compat-incompatible', compat.detail)
      return
    }
    // unverified：不立即降级（避免 DSH 版本读取瞬态失败误伤）；STARTING 先进 UNPAIRED
    // 等 20s 窗口，超时后由 tick 归因为 compat-unverified。
    if (state === 'STARTING') {
      enterUnpaired(`compat-unverified:${compat.code}`)
    }
  }

  /** 把一次握手评估排进串行队列（tick 与 control/status 回调共用，避免并发乱序）。 */
  function queueHandshakeEvaluation(): void {
    handshakeQueue = handshakeQueue
      .then(() => runHandshakeEvaluation())
      .catch((error: unknown) => {
        log('warn', `握手评估异常: ${errorText(error)}`)
      })
  }

  /** 等待已排队握手评估全部完成（tick 内确定性地落状态）。 */
  async function flushHandshakeEvaluation(): Promise<void> {
    await handshakeQueue
  }

  /** UNPAIRED 超时后的降级归因：能明确是 compat 不可验证就归 compat，否则视为桥未加载。 */
  function unpairedTimeoutReason(): DshDegradedReason {
    if (handshakeFactorsHealthy() && lastCompat?.status === 'unverified') return 'compat-unverified'
    return 'no-bridge-unpaired'
  }

  /** 组装 UNPAIRED 超时的可读 detail（含桥诊断/安装清单证据，对应 E6 可解释性）。 */
  function unpairedDetail(reason: DshDegradedReason): string {
    if (reason === 'compat-unverified') {
      return lastCompat?.detail ?? '握手不可验证（DSH 版本或桥声明范围无法解析）'
    }
    const parts = [
      `DSH 在运行但桥握手未建立（status.online=${String(lastStatusOnline)}，control.attached=${String(
        controlAttached && !bridgeDetached
      )}）`
    ]
    if (bridgeDiagnostic) {
      parts.push(`桥诊断 ${bridgeDiagnostic.phase}: ${bridgeDiagnostic.message}`)
    } else if (installManifest) {
      parts.push(
        `安装清单：桥 v${installManifest.bridgeVersion}，声明范围 ${
          installManifest.dshRange ?? '未声明'
        }（桥可能被 DSH 版本闸门禁用或未加载）`
      )
    }
    return parts.join('；')
  }

  /* --------------------------- 重启恢复（仅 PAIRED） --------------------------- */

  /** 发起一次级联退出（只触发一次；之后所有动作短路）。 */
  function cascade(reason: DshQuitReason): void {
    if (state === 'CASCADING' || stopped) return
    state = 'CASCADING'
    quitReason = reason
    clearTick()
    clearOperationalTimers()
    log(
      'warn',
      reason === 'dsh-degraded'
        ? `级联退出（${reason}）：DSH 已退出（降级联动：不重启、不发信号）`
        : `级联退出（${reason}）：DSH 已不可恢复`,
      { lastKnownRunning }
    )
    requestQuit(reason)
  }

  /** 调用注入的 quit（只调用一次，异常只 log）。 */
  function requestQuit(reason: DshQuitReason): void {
    if (quitSent) return
    quitSent = true
    try {
      quit?.(reason)
    } catch (error) {
      log('warn', `quit 回调异常: ${errorText(error)}`)
    }
  }

  /** STARTING 拉起限流：60s 冷却 + 窗口内最多 3 次。 */
  function canLaunch(): boolean {
    const current = now()
    launchHistory = launchHistory.filter((ts) => current - ts < launchWindowMs)
    if (launchHistory.length >= maxLaunchesPerWindow) return false
    const last = launchHistory[launchHistory.length - 1]
    if (last !== undefined && current - last < launchCooldownMs) return false
    return true
  }

  /** 发起一次「拉起 DSH」（STARTING 专用，带限流）。 */
  async function attemptStartupLaunch(): Promise<void> {
    if (quitting()) return
    if (!canLaunch()) {
      log('debug', '拉起冷却中，跳过本次', { launchHistory })
      return
    }
    launchHistory.push(now())
    let ok = false
    try {
      ok = await dshProcess.launch()
    } catch (error) {
      log('warn', `拉起 DSH 异常: ${errorText(error)}`)
    }
    log('info', ok ? '已拉起 DSH（open -b 幂等）' : '拉起 DSH 失败', {
      attempts: launchHistory.length,
      cooldownMs: launchCooldownMs
    })
    // 拉起后进程状态未知（DSH 可能正在启动）：退出时不能再用旧的「未运行」结论走快速放行。
    if (ok) lastKnownRunning = null
  }

  /** 一次恢复尝试：拉起 → 等 restartIntervalMs → 验证。 */
  async function recoveryAttempt(): Promise<void> {
    const current = recovery
    if (!current || stopped || state !== 'PAIRED') return
    if (current.attempts >= maxRestarts) {
      log('warn', '重启次数已达上限，仍未恢复', {
        reason: current.reason,
        attempts: current.attempts
      })
      // v2：不再 cascade 自杀 —— 转 DEGRADED 常驻（DSH 修好后握手恢复自动回 PAIRED）。
      recovery = null
      enterDegraded(
        'crash-recovery-failed',
        `DSH 崩溃后重启 ${maxRestarts} 次仍失败（已停止重启；DSH 修复后可手动打开，桌宠会自动恢复联动）`
      )
      return
    }
    current.attempts += 1
    log('info', `尝试重启 DSH（${current.reason}）第 ${current.attempts}/${maxRestarts} 次`)
    try {
      await dshProcess.launch()
    } catch (error) {
      log('warn', `重启拉起异常: ${errorText(error)}`)
    }
    // 重启拉起后进程状态未知，等 verifyRecovery 再刷新；避免退出时错误快速放行。
    lastKnownRunning = null
    // launch 期间可能收到 attached（HMR）或用户关闭耦合 → 先检查再定时验证。
    if (recovery !== current || stopped || state !== 'PAIRED') return
    current.verifyHandle = timers.setTimeout(() => {
      current.verifyHandle = null
      void verifyRecovery(current)
    }, restartIntervalMs)
  }

  /** 重启后验证：进程活着（detached 恢复还要求出现新的 attached）→ 恢复成功，否则继续/降级。 */
  async function verifyRecovery(current: RecoveryState): Promise<void> {
    if (recovery !== current || stopped || state !== 'PAIRED') return
    const running = await probeRunning()
    if (recovery !== current || stopped || state !== 'PAIRED') return
    const bridgeHealthy =
      current.reason === 'detached'
        ? attachedAt !== null && attachedAt !== current.attachedBefore
        : true
    if (running && bridgeHealthy) {
      log('info', 'DSH 已恢复', { reason: current.reason, attempts: current.attempts })
      recovery = null
      return
    }
    log('warn', '重启后验证失败', {
      reason: current.reason,
      running,
      bridgeHealthy,
      attempts: current.attempts
    })
    void recoveryAttempt()
  }

  /** 进入崩溃恢复流程（仅限「无 detached 的进程消失」，即真崩溃/被强杀）。 */
  function beginRecovery(reason: DshRecoveryReason): void {
    if (recovery || stopped || state !== 'PAIRED' || quitting()) return
    // 显式退出候选绝不重启（强耦合：一方退出另一方跟随退出，而不是把对方拉回来）。
    if (bridgeDetached) {
      log('info', `收到过 detached，不进入重启恢复（${reason}）→ 保持显式退出语义`)
      return
    }
    log('warn', `DSH 疑似崩溃，进入重启恢复（${reason}）`, { lastKnownRunning })
    recovery = {
      reason,
      attempts: 0,
      verifyHandle: null,
      attachedBefore: attachedAt
    }
    void recoveryAttempt()
  }

  /**
   * PAIRED 下探测到进程消失：先等一个 grace 窗口再决定「显式退出」还是「崩溃」。
   *
   * 为什么需要确认窗口：桥 dispose 写 `detached`（进程随后才退出）与 pet 的 3s tick 探测是
   * 两条独立时间线 —— tick 可能抢在 watcher 的 750ms 轮询之前看到「进程已不在」。旧实现直接
   * 按崩溃重启，导致**用户关闭 DSH 后桌宠又把 DSH 拉起来**（2026-11-11 实机 bug）。
   */
  function beginExitConfirm(): void {
    if (exitConfirmHandle !== null || stopped || state !== 'PAIRED' || quitting()) return
    log(
      'warn',
      `探测到 DSH 进程消失，等待 ${graceMs}ms 确认：收到 detached = 显式退出（跟随退出），否则按崩溃重启`
    )
    exitConfirmHandle = timers.setTimeout(() => {
      exitConfirmHandle = null
      void confirmExitAfterProcessGone()
    }, graceMs)
  }

  /** 确认窗口到期：复核进程 + detached 标记，决定跟随退出还是崩溃重启。 */
  async function confirmExitAfterProcessGone(): Promise<void> {
    if (stopped || state !== 'PAIRED' || quitting() || recovery) return
    const running = await probeRunning()
    if (stopped || state !== 'PAIRED' || quitting() || recovery) return
    if (running) {
      log('info', '确认窗口内 DSH 恢复为运行状态（探测抖动？），保持 PAIRED')
      return
    }
    if (bridgeDetached) {
      log('info', '确认窗口内收到 detached 且 DSH 已不在 → 显式退出，跟随退出（dsh-exit，不重启）')
      cascade('dsh-exit')
      return
    }
    log('warn', '确认窗口内始终没有 detached（崩溃/被 SIGKILL）→ 进入重启恢复（process-gone）')
    beginRecovery('process-gone')
  }

  /** detached grace 到期回调。 */
  async function onGraceExpired(): Promise<void> {
    if (stopped || state === 'CASCADING' || quitting()) return
    if (state === 'STARTING') {
      // 桥曾 attached 说明 DSH 启动过；此刻 detached 可能仍在启动/HMR 中 → 以握手评估为准。
      const running = await probeRunning()
      if (stopped || state !== 'STARTING' || !running) return
      queueHandshakeEvaluation()
      await flushHandshakeEvaluation()
      if (stopped || state !== 'STARTING') return
      // detached 后 controlAttached=false，握手四门槛不成立 → UNPAIRED 等重新 attached。
      enterUnpaired('detached-grace-unhealthy')
      return
    }
    if (state !== 'PAIRED') return
    // 强耦合语义（用户 2026-11-11 决策 B：一方退出另一方跟随退出）：
    // - detached + 进程已不在 = DSH 显式退出（dispose 已执行）→ 桌宠跟随退出，**不重启**；
    // - detached + 进程仍在 = HMR 重载慢 / 插件被卸载但宿主存活 → 不重启不退出，保持 PAIRED
    //   等待重新 attached；此后进程再消失仍按「显式退出」跟随退出（tickPaired 兜底）。
    const running = await probeRunning()
    if (stopped || state !== 'PAIRED' || quitting()) return
    if (!running) {
      log('info', 'detached grace 到期且 DSH 进程已不在 → 跟随退出（dsh-exit，不重启）')
      cascade('dsh-exit')
      return
    }
    detachedWaitLogged = true
    log(
      'warn',
      `detached grace 到期但 DSH 进程仍在运行（HMR 重载/插件卸载？），保持等待重新 attached；` +
        `若 ${bridgeLostGraceMs}ms 内不恢复将降级 DEGRADED(bridge-lost)`
    )
  }

  /* ------------------------------ 状态 tick ------------------------------ */

  /** STARTING 状态 tick：拉起/限时拉起失败/进程在跑则评估握手。 */
  async function tickStarting(): Promise<void> {
    const running = await probeRunning()
    if (stopped || state !== 'STARTING' || quitting()) return
    if (running) {
      queueHandshakeEvaluation()
      await flushHandshakeEvaluation()
      if (stopped || state !== 'STARTING' || quitting()) return
      // 进程在跑但四门槛未同时成立：进入 UNPAIRED 等握手（20s 超时 → DEGRADED）。
      enterUnpaired('startup-handshake-unhealthy')
      return
    }
    // 拉起失败限时：首次拉起后 DRH_STARTUP_GIVEUP_MS 内仍不在运行 → DEGRADED(startup-failed)。
    if (firstLaunchAt === null) firstLaunchAt = now()
    const elapsed = now() - firstLaunchAt
    if (elapsed >= startupGiveupMs) {
      const diagnosticSuffix = bridgeDiagnostic
        ? `；桥诊断 ${bridgeDiagnostic.phase}: ${bridgeDiagnostic.message}`
        : ''
      enterDegraded(
        'startup-failed',
        `DSH 拉起失败：${Math.round(elapsed / 1000)}s 内未能启动（已停止无限重试；` +
          `请手动打开 DSH 修复桌宠，或检查 DSH 是否已安装/被闸门禁用）${diagnosticSuffix}`
      )
      return
    }
    await attemptStartupLaunch()
  }

  /** UNPAIRED 状态 tick：握手恢复 → PAIRED；进程消失 → 跟随退出；20s 超时 → DEGRADED。 */
  async function tickUnpaired(): Promise<void> {
    const running = await probeRunning()
    if (stopped || state !== 'UNPAIRED' || quitting()) return
    if (!running) {
      // E2/E3：降级/未配对下 DSH 进程消失 → 单向跟随退出（不重启、不发信号）。
      log('info', 'UNPAIRED 下探测到 DSH 进程消失 → 跟随退出（dsh-degraded，不重启）')
      cascade('dsh-degraded')
      return
    }
    queueHandshakeEvaluation()
    await flushHandshakeEvaluation()
    if (stopped || state !== 'UNPAIRED' || quitting()) return
    if (unpairedSince === null) unpairedSince = now()
    if (now() - unpairedSince < unpairedGraceMs) return
    const reason = unpairedTimeoutReason()
    enterDegraded(reason, unpairedDetail(reason))
  }

  /** PAIRED 状态 tick：显式退出候选/进程消失/崩溃恢复 + 桥信号丢失监控。 */
  async function tickPaired(): Promise<void> {
    if (recovery || exitConfirmHandle !== null) return
    if (bridgeDetached) {
      // HMR 竞态期：grace 未到期时交回 grace 定时器裁决（它会在到期时探测并决定跟随退出/等待）。
      if (graceHandle !== null) return
      const running = await probeRunning()
      if (stopped || state !== 'PAIRED' || quitting()) return
      if (!running) {
        log('info', 'detached 后探测到 DSH 进程消失 → 跟随退出（dsh-exit，不重启）')
        cascade('dsh-exit')
        return
      }
      if (!detachedWaitLogged) {
        detachedWaitLogged = true
        log('debug', 'detached 后 DSH 进程仍在运行，保持等待重新 attached')
      }
      monitorPairedBridgeHealth()
      return
    }
    const running = await probeRunning()
    if (stopped || state !== 'PAIRED' || quitting()) return
    if (!running) {
      beginExitConfirm()
      return
    }
    monitorPairedBridgeHealth()
  }

  /** PAIRED 下桥信号（online 心跳 / control attached）丢失超时 → DEGRADED(bridge-lost)。 */
  function monitorPairedBridgeHealth(): void {
    if (handshakeFactorsHealthy()) {
      bridgeUnhealthySince = null
      return
    }
    if (bridgeUnhealthySince === null) {
      bridgeUnhealthySince = now()
      log('warn', 'PAIRED 下桥握手信号丢失，开始计时（超时将降级 bridge-lost）', {
        lastStatusOnline,
        controlAttached,
        bridgeDetached,
        bridgeLostGraceMs
      })
      return
    }
    if (now() - bridgeUnhealthySince >= bridgeLostGraceMs) {
      enterDegraded(
        'bridge-lost',
        `PAIRED 下桥信号（status 心跳/control attached）丢失超过 ${Math.round(
          bridgeLostGraceMs / 1000
        )}s（status.online=${String(lastStatusOnline)}，control.attached=${String(
          controlAttached && !bridgeDetached
        )}）`
      )
    }
  }

  /** DEGRADED 状态 tick：进程消失 → 跟随退出；握手恢复 → 自动回 PAIRED；其它一律不动。 */
  async function tickDegraded(): Promise<void> {
    const running = await probeRunning()
    if (stopped || state !== 'DEGRADED' || quitting()) return
    if (!running) {
      if (!degradedSawRunning) {
        // 进入降级时 DSH 就不在运行（startup-failed / crash-recovery-failed）：
        // 保持 DEGRADED 常驻等用户手动打开 DSH；打开后握手恢复自动回 PAIRED。
        if (!degradedWaitLogged) {
          degradedWaitLogged = true
          log('info', 'DEGRADED 下 DSH 未运行（本次降级内未观察到运行），保持常驻等待用户手动打开 DSH')
        }
        return
      }
      log('info', 'DEGRADED 下 DSH 进程消失 → 跟随退出（dsh-degraded，不重启、不发信号）')
      cascade('dsh-degraded')
      return
    }
    degradedSawRunning = true
    // 每 3s 重试握手评估；健康则自动回 PAIRED（联动语义恢复），否则保持 DEGRADED 常驻。
    queueHandshakeEvaluation()
    await flushHandshakeEvaluation()
  }

  /** 异步 tick 主体（异常隔离 + 重入保护）。 */
  async function runTick(): Promise<void> {
    if (stopped || ticking || state === 'CASCADING') return
    // 退出流程中绝不重启 DSH（否则用户退出桌宠会把 DSH 又拉起来）。
    if (quitting()) return
    ticking = true
    try {
      refreshConfig()
      if (inert() || quitting()) return
      // 桥目录静态信号（install.json / bridge-error.json）每 tick 刷新一次（mtime 缓存）：
      // UNPAIRED/startup-failed 的降级 detail 需要它来解释"桥为什么没加载"（E6）。
      refreshBridgeDirState()
      if (inert() || quitting()) return
      if (state === 'STARTING') await tickStarting()
      else if (state === 'UNPAIRED') await tickUnpaired()
      else if (state === 'PAIRED') await tickPaired()
      else if (state === 'DEGRADED') await tickDegraded()
    } catch (error) {
      log('warn', `tick 异常: ${errorText(error)}`)
    } finally {
      ticking = false
    }
  }

  /**
   * 重新求值配置/安全模式：
   * - 禁用 → DISABLED（清操作类定时器，不杀 DSH）；
   * - 启用（从 DISABLED）→ STARTING 并立即 tick。
   */
  function refreshConfig(): void {
    if (stopped) return
    const nextEnabled = evaluateEnabled()
    if (nextEnabled === enabled && (!nextEnabled || state !== 'DISABLED')) {
      enabled = nextEnabled
      return
    }
    enabled = nextEnabled
    if (!nextEnabled) {
      if (state !== 'DISABLED') {
        log('info', '强耦合已禁用（config/env/safe-mode），停止生命周期动作；不终止 DSH')
        state = 'DISABLED'
        clearOperationalTimers()
        resetWaitingTracking()
      }
      return
    }
    if (state === 'DISABLED') {
      state = 'STARTING'
      resetWaitingTracking()
      log('info', '强耦合已启用，进入 STARTING', {
        isPackaged,
        config: readConfig(),
        env: {
          coupling: env[PET_DSH_COUPLING_ENV] ?? null,
          disable: env[PET_DSH_COUPLING_DISABLE_ENV] ?? null
        }
      })
      void runTick()
    }
  }

  return {
    getState(): DshLifecycleState {
      return state
    },
    isEnabled(): boolean {
      return enabled
    },
    getQuitReason(): DshQuitReason | null {
      return quitReason
    },
    start(): void {
      if (started || stopped) return
      started = true
      refreshConfig()
      if (tickHandle === null) {
        tickHandle = timers.setInterval(() => {
          void runTick()
        }, tickMs)
      }
    },
    stop(): void {
      if (stopped) return
      stopped = true
      clearTick()
      clearOperationalTimers()
      log('info', '生命周期已停止（不做任何后续动作）')
    },
    refreshConfig(): void {
      refreshConfig()
    },
    tick(): Promise<void> {
      return runTick()
    },
    handleControl(frame: DshBridgeControlFile): void {
      if (stopped || state === 'CASCADING') return
      if (frame.action === 'attached') {
        attachedAt = frame.ts
        lastKnownRunning = true
        // HMR 竞态：grace 内重新 attached → 取消「疑似退出」判定。
        bridgeDetached = false
        detachedWaitLogged = false
        controlAttached = true
        controlCompat = parseDshBridgeCompat(frame.compat)
        controlBridgeVersion =
          controlCompat?.bridgeVersion ?? normalizeBridgeVersion(frame.bridgeVersion)
        clearGrace()
        clearExitConfirm()
        if (recovery) cancelRecovery('bridge-attached')
        // v2：不再直接 enterPaired —— 交给握手评估（进程+心跳+compat 四门槛）。
        if (
          state === 'STARTING' ||
          state === 'UNPAIRED' ||
          state === 'DEGRADED' ||
          state === 'PAIRED'
        ) {
          queueHandshakeEvaluation()
        }
        if (state === 'PAIRED') {
          log('debug', '桥已 attached（PAIRED）', { ts: frame.ts, dshPid: frame.dshPid })
        }
        return
      }

      // detached：桥 dispose（DSH 退出 或 HMR 卸载）——不能单独证明 DSH 退出，走 grace。
      if (quitting()) return
      controlAttached = false
      controlCompat = null
      controlBridgeVersion = null
      if (state !== 'STARTING' && state !== 'PAIRED') return
      // 显式退出候选：作废任何进行中的重启恢复 / 进程消失确认，绝不再拉起 DSH。
      bridgeDetached = true
      detachedWaitLogged = false
      cancelRecovery('bridge-detached')
      clearExitConfirm()
      if (graceHandle !== null) return
      log('info', '收到 detached，等待重新 attached（grace）', {
        graceMs,
        ts: frame.ts,
        dshPid: frame.dshPid
      })
      graceHandle = timers.setTimeout(() => {
        graceHandle = null
        void onGraceExpired()
      }, graceMs)
    },
    handleStatus(status: DshStatus): void {
      if (stopped || state === 'CASCADING') return
      if (!status.online) {
        // v2：记录 online=false（watcher 心跳 TTL 到期会推一次），PAIRED 下由 tick 监控降级。
        lastStatusOnline = false
        return
      }
      lastStatusOnline = true
      lastKnownRunning = true
      // 心跳 online = 桥活着 → 之前的 detached 已被新的桥实例取代（或本就是陈旧帧）。
      bridgeDetached = false
      detachedWaitLogged = false
      clearGrace()
      clearExitConfirm()
      // v2：不再直接 enterPaired —— 交给握手评估（可能还缺 control attached / compat）。
      if (
        state === 'STARTING' ||
        state === 'UNPAIRED' ||
        state === 'DEGRADED' ||
        state === 'PAIRED'
      ) {
        queueHandshakeEvaluation()
      }
    },
    handleBeforeQuit(event: DshQuitEvent): void {
      if (stopped) return
      // 防互杀环①：已在退出流程 / 因 DSH 退出而退出 → 绝不再向 DSH 发信号。
      if (state === 'CASCADING' || quitReason !== null || dshTerminatedByPet || petQuitPrepared) {
        return
      }
      if (!evaluateEnabled()) return
      // 防互杀环②：v2 安全语义 —— 只有 PAIRED（握手健康）才允许终止 DSH；
      // UNPAIRED/DEGRADED/DISABLED 一律放行，保证「打开 DSH 修桌宠」不会被桌宠杀掉。
      if (state !== 'PAIRED') {
        log('info', `桌宠退出：当前状态 ${state}（未 PAIRED），不终止 DSH，直接放行`)
        return
      }
      // 终止流程进行中又收到 before-quit（用户重复点退出）：继续拦截，等待流程收尾。
      if (quitFlowInProgress) {
        event.preventDefault()
        return
      }
      // 已知 DSH 不在运行 → 无需异步等待，直接放行。
      if (lastKnownRunning === false) {
        log('info', '桌宠退出：DSH 未运行，直接放行')
        return
      }

      event.preventDefault()
      log('info', '桌宠退出：握手健康（PAIRED），先终止 DSH（SIGTERM→SIGKILL）再退出')
      void terminateDshForQuit()
    }
  }

  /** 桌宠退出前终止 DSH（≤5s SIGTERM 升级 SIGKILL；失败也继续退出）。 */
  async function terminateDshForQuit(): Promise<void> {
    if (stopped || quitFlowInProgress) return
    quitFlowInProgress = true
    const startedAt = now()
    try {
      const running = await probeRunning()
      if (!running) {
        log('info', '桌宠退出：探测到 DSH 已不在运行，跳过终止')
        finishQuit()
        return
      }
      let pid: number | null = null
      try {
        pid = await dshProcess.getPid()
      } catch (error) {
        log('warn', `退出前获取 DSH pid 失败: ${errorText(error)}`)
      }
      if (pid === null) {
        log('warn', '桌宠退出：拿不到 DSH pid，跳过终止（继续退出）')
        finishQuit()
        return
      }
      let result: string = 'failed'
      try {
        result = await dshProcess.terminate(pid)
      } catch (error) {
        log('warn', `终止 DSH 异常（继续退出）: ${errorText(error)}`)
      }
      dshTerminatedByPet = true
      log('info', `已终止 DSH pid=${pid}（${result}，${now() - startedAt}ms）`)
    } catch (error) {
      // 任何异常都不能卡住桌宠退出（契约 §4.1：失败只 log）。
      log('warn', `退出前终止 DSH 流程异常（继续退出）: ${errorText(error)}`)
      dshTerminatedByPet = true
    }
    finishQuit()
  }

  /** 终止流程结束：标记退出握手完成并再次请求退出（第二次 before-quit 会被放行）。 */
  function finishQuit(): void {
    quitFlowInProgress = false
    petQuitPrepared = true
    quitReason = 'pet-exit'
    requestQuit('pet-exit')
  }
}
