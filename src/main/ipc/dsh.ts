/**
 * DSH 联动相关 IPC 注册入口（Wave 2 B7 起；Wave 3 A3 扩展强耦合生命周期；
 * 2026-11-11 兼容性安全 v2 接入版本/兼容/安全模式/告警）。
 *
 * 契约（`src/shared/ipc.ts` 冻结）：
 * - `pet:dsh-status` → `DshStatus`（`online/running/lastEventAt/lastType`）；
 * - 主进程尾随桥文件（`~/.dsh/aventurine-pet/{status.json,events.jsonl,control.json}`，
 *   见 `src/main/desktop/dsh-watch.ts`），事件变化时 `ctx.broadcast('dsh-event', event)`
 *   推给所有 overlay renderer。
 *
 * Wave 3 A3 增量（**不新增 IPC channel**，生命周期状态复用 `pet:dsh-status`）：
 * - 创建单例 `DshLifecycle`（`src/main/desktop/dsh-lifecycle.ts`），配置从 Lead 提供的
 *   `config-access`（`getActiveConfig`/`onActiveConfigChanged`）读取，设置页改开关即时生效；
 * - 接 `control.json` 的 `onControl`（attached/detached → 1.5s grace 判定）与 status 心跳；
 * - `app.on('before-quit')`：仅握手健康（PAIRED）时 SIGTERM DSH（quitReason 防互杀环）；
 * - `app.once('will-quit')`：停 watcher/lifecycle、取消配置订阅，不残留定时器。
 *
 * 兼容性安全 v2 增量（`docs/pet-dsh-coupling-safety-plan-2026-11-11.md` §2/§6.3）：
 * - `createDshVersionDetector()`：读 DSH app `Info.plist` 版本（60s 缓存，失败 null 不抛）；
 * - `createBridgeStateReader({ dir: watcher.dir })`：读 `install.json`/`bridge-error.json` 静态信号；
 * - 安全模式：`~/.dsh/aventurine-pet/safe-mode` 存在即视同耦合关闭（每 tick 重查，热生效）；
 * - `onCouplingAlert`：进入 DEGRADED 一次 modal（每 app 运行同原因只弹一次）+ 系统通知 +
 *   `main.log`；恢复 PAIRED 只通知不弹 modal；`PET_DSH_COUPLING_SILENT_ALERTS=1` 时只写日志
 *   （E2E/自动化静默）。
 *
 * 关键约束（PLAN §8 / docs/wave2-integration.md §3-B7 / wave3 设计 §4）：
 * - **仅 `status.online === true` 时才转发事件**：status.json 陈旧/显式 `offline:true`
 *   时（DSH 已退出）不得把 `events.jsonl` 里的陈旧事件再喂给渲染层；
 * - 不注册其它 channel（`ipcMain.handle` 重复注册会抛错）；
 * - 所有耦合动作可注入/可关闭：dev（未打包）必须 `PET_DSH_COUPLING=1` 才启用，
 *   `PET_DSH_COUPLING_DISABLE=1` 任何构建下强制关闭；测试默认关闭，绝不杀真实 DSH。
 *
 * 接线：`src/main/ipc/index.ts` 已在 ready 后调用一次 `registerDshIpc(ctx, logger)`。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { app, dialog, ipcMain, Notification } from 'electron'

import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { DshStatus } from '@shared/types'

import type { AppContext } from '../app-context'
import { getActiveConfig, onActiveConfigChanged } from '../config-access'
import type { DshCouplingAlert } from '../desktop/dsh-lifecycle'
import { createDshLifecycle } from '../desktop/dsh-lifecycle'
import { createBridgeStateReader } from '../desktop/dsh-bridge-state'
import { createDshProcess } from '../desktop/dsh-process'
import { createDshVersionDetector } from '../desktop/dsh-version'
import { createDshWatcher } from '../desktop/dsh-watch'
import type { DshWatchLogger } from '../desktop/dsh-watch'

/** 安全模式文件名（桥目录下存在即视同耦合关闭；`~/.dsh/aventurine-pet/safe-mode`）。 */
export const DSH_SAFE_MODE_FILE = 'safe-mode'

/** 告警静默 env（E2E/自动化）：`PET_DSH_COUPLING_SILENT_ALERTS=1` 时只写 main.log。 */
export const PET_DSH_COUPLING_SILENT_ALERTS_ENV = 'PET_DSH_COUPLING_SILENT_ALERTS'

/** 告警文案（modal / Notification 共用；测试可直接断言字段）。 */
export interface CouplingAlertText {
  title: string
  message: string
  detail: string
}

/**
 * 生成耦合告警文案（纯函数）：**必须**包含原因码、DSH 版本、桥期望范围，以及
 * "DSH 本体不受影响 + runbook"的逃生指引（计划 §2.4）。
 */
export function formatCouplingAlertText(alert: DshCouplingAlert): CouplingAlertText {
  const degraded = alert.kind === 'degraded'
  const title = degraded ? '桌宠联动降级（DSH 本体不受影响）' : '桌宠联动已恢复'
  const message = degraded ? `联动降级：${alert.code}` : `联动已恢复（此前：${alert.code}）`
  const lines = [
    `原因码：${alert.code}`,
    `DSH 版本：${alert.dshVersion ?? '未知'}`,
    `桥版本：${alert.bridgeVersion === null ? '未知' : `v${alert.bridgeVersion}`}`,
    `桥期望 DSH 范围：${alert.dshRange ?? '未知'}`,
    `状态：${alert.state}`,
    `原因：${alert.reason}`,
    degraded
      ? 'DSH 本体不受影响，可正常打开/关闭；修复步骤见 docs/pet-dsh-coupling-runbook.md'
      : '联动已自动恢复；若反复降级，修复步骤见 docs/pet-dsh-coupling-runbook.md'
  ]
  return { title, message, detail: lines.join('\n') }
}

/** 告警通知依赖（全部可注入；单测直接断言 dialog/Notification/日志行为）。 */
export interface CouplingAlertNotifierOptions {
  /** 环境变量源（默认 `process.env`；读静默开关）。 */
  env?: NodeJS.ProcessEnv
  /** 日志接口（告警必须落 main.log；默认静默）。 */
  logger?: Pick<DshWatchLogger, 'warn'> & Pick<Partial<DshWatchLogger>, 'info'>
  /** 弹一次性 modal（默认 Electron `dialog.showMessageBox`；失败静默）。 */
  showDialog?: (text: CouplingAlertText) => void
  /** 系统通知（默认 Electron `Notification`；失败静默）。 */
  showNotification?: (text: CouplingAlertText) => void
}

/** 默认 modal 实现：`dialog.showMessageBox` 失败/不可用都静默（提示不能影响主流程）。 */
function defaultShowDialog(text: CouplingAlertText): void {
  try {
    const result = dialog?.showMessageBox?.({
      type: 'warning',
      title: text.title,
      message: text.message,
      detail: text.detail,
      buttons: ['知道了'],
      defaultId: 0,
      noLink: true
    })
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      ;(result as Promise<unknown>).catch(() => {
        // 弹窗失败静默
      })
    }
  } catch {
    // 弹窗失败静默
  }
}

/** 默认系统通知实现：`Notification` 不可用/平台不支持/构造失败都静默。 */
function defaultShowNotification(text: CouplingAlertText): void {
  try {
    if (typeof Notification !== 'function') return
    const supported = (Notification as unknown as { isSupported?: () => boolean }).isSupported
    if (typeof supported === 'function' && !supported.call(Notification)) return
    new Notification({ title: text.title, body: `${text.message}\n${text.detail}` }).show()
  } catch {
    // 通知失败静默
  }
}

/**
 * 创建耦合告警分发器（每次 app 运行一个实例，由 `registerDshIpc` 持有）。
 *
 * 行为（计划 §2.4）：
 * - 所有告警都写 main.log（warn）；
 * - `PET_DSH_COUPLING_SILENT_ALERTS=1` → 只写日志，不弹窗/不通知；
 * - `degraded`：**同一原因码每次 app 运行只弹一次 modal** + 每次进入都发通知；
 * - `recovered`：只发通知（不弹 modal）。
 */
export function createCouplingAlertNotifier(
  options: CouplingAlertNotifierOptions = {}
): (alert: DshCouplingAlert) => void {
  const env = options.env ?? process.env
  const logger = options.logger
  const showDialog = options.showDialog ?? defaultShowDialog
  const showNotification = options.showNotification ?? defaultShowNotification
  /** 已弹过 modal 的原因码（每次 app 运行去重；Notification 不参与去重）。 */
  const dialogNotified = new Set<string>()

  return (alert: DshCouplingAlert): void => {
    try {
      const text = formatCouplingAlertText(alert)
      try {
        logger?.warn?.(`[dsh-ipc] 耦合告警 kind=${alert.kind} code=${alert.code}`, {
          reason: alert.reason,
          dshVersion: alert.dshVersion,
          bridgeVersion: alert.bridgeVersion,
          dshRange: alert.dshRange,
          state: alert.state
        })
      } catch {
        // 日志失败不影响告警流程
      }
      if (env[PET_DSH_COUPLING_SILENT_ALERTS_ENV] === '1') return

      if (alert.kind === 'degraded' && !dialogNotified.has(alert.code)) {
        dialogNotified.add(alert.code)
        showDialog(text)
      }
      showNotification(text)
    } catch {
      // 告警链路任何异常都静默（不能反过来影响生命周期/桌宠主流程）
    }
  }
}

/** 安全模式文件是否存在（生产默认 `fs.existsSync`；单测可注入 fake）。 */
export function isSafeModeFilePresent(
  dir: string,
  exists: (path: string) => boolean = existsSync
): boolean {
  try {
    return exists(join(dir, DSH_SAFE_MODE_FILE))
  } catch {
    return false
  }
}

/**
 * 注册 DSH 领域 handler（ready 后由 `ipc/index.ts` 聚合调用一次）。
 *
 * 目录解析在 `createDshWatcher` 内完成（默认 `~/.dsh/aventurine-pet`，env `PET_DSH_DIR`
 * 可覆盖，便于测试/排障）；构造阶段不触碰文件系统，`start()` 才轮询。
 *
 * @param ctx 应用上下文（事件广播）
 * @param logger 进程级 logger（L-4 接线；可选，未注入时 watcher 回退 console.warn）
 */
export function registerDshIpc(ctx: AppContext, logger?: DshWatchLogger): void {
  const watcher = createDshWatcher(logger ? { logger } : {})
  // isPackaged 必须传入：打包版禁用 dev 测试钩子（即使环境变量被伪造也不执行任意命令）。
  const dshProcess = createDshProcess({
    isPackaged: app.isPackaged === true,
    ...(logger ? { logger } : {})
  })
  // 版本探测器延迟到第一次握手评估才读盘/起命令（构造无 IO；失败 null 不抛）。
  const versionDetector = createDshVersionDetector()
  // 桥目录静态信号（install.json / bridge-error.json）：mtime 缓存，每 tick 调用便宜。
  const bridgeStateReader = createBridgeStateReader({
    dir: watcher.dir,
    ...(logger ? { logger } : {})
  })
  const notifyCouplingAlert = createCouplingAlertNotifier({
    env: process.env,
    ...(logger ? { logger } : {})
  })
  const lifecycle = createDshLifecycle({
    process: dshProcess,
    getConfig: () => getActiveConfig(),
    isPackaged: app.isPackaged === true,
    ...(logger ? { logger } : {}),
    getDshVersion: async (): Promise<string | null> => {
      const info = await versionDetector.detect()
      return info.version
    },
    readBridgeDirState: () => bridgeStateReader.read(),
    isSafeMode: () => isSafeModeFilePresent(watcher.dir),
    onCouplingAlert: notifyCouplingAlert,
    // 级联退出 / 退出前终止 DSH 后，走 Electron 正常退出流程（会再次触发 before-quit，
    // 此时 lifecycle 的 quitReason/dshTerminatedByPet 标记保证不会重复拦截）。
    quit: () => {
      app.quit()
    }
  })

  ipcMain.handle(IPC.dshStatus, (): DshStatus => watcher.getStatus())

  watcher.onEvent((event) => {
    // 只转发「当前确实在线」的事件；watcher 的 getStatus 已在同一轮轮询里刷新过。
    if (!watcher.getStatus().online) return
    ctx.broadcast(IPC_EVENTS.dshEvent, event)
  })

  // Wave 3 A3：桥控制帧（attached/detached）与心跳进入生命周期状态机。
  watcher.onControl((control) => {
    lifecycle.handleControl(control)
  })
  watcher.onStatusChanged((status) => {
    lifecycle.handleStatus(status)
  })

  // 设置页改 dshCoupling 后即时生效（不重启 pet）。
  const unsubscribeConfig = onActiveConfigChanged(() => {
    lifecycle.refreshConfig()
  })

  // 桌宠显式退出 → 仅握手健康（PAIRED）时先终止 DSH 再退出（其余状态放行，绝不杀 DSH）。
  app.on('before-quit', (event) => {
    lifecycle.handleBeforeQuit(event)
  })

  watcher.start()
  lifecycle.start()

  app.once('will-quit', () => {
    watcher.stop()
    lifecycle.stop()
    unsubscribeConfig()
  })
}
