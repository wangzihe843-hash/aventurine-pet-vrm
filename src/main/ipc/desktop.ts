/**
 * 桌面感知相关 IPC 注册入口（Wave 1 A4 实现）。
 *
 * 所有权（PLAN §17.5 P1-10；独立复验 MED-3 修正）：
 * - **A4**：注册 `pet:windows`（其它应用窗口列表），并每 250ms 轮询 Swift 助手
 *   `native/winlist`，列表变化时广播 `windows-updated`；
 * - **Wave 3 C1**：`pet:move-window`（真实拖动其它窗口）在本文件续填；
 * - **A1**：`pet:set-ignore-mouse` / `pet:set-visible` / `pet:quit` 一律在
 *   `src/main/ipc/window.ts` 注册 —— 本文件**不得**注册，否则与 A1 重复
 *   `ipcMain.handle` 会在启动时抛错（非 smoke 模式直接 `app.exit(1)` 崩溃）。
 *
 * 通用规则：新增/续填 handler 前先 `grep -R "ipcMain.handle" src/main`，
 * 确认该 channel 尚未被其它 registrar 注册（`ipcMain.handle` 重复注册同一 channel 会抛错）。
 *
 * 本文件由对应任务填充，`src/main/index.ts` 不再改动（`ipc/index.ts` 已聚合接线）。
 */
import { app, ipcMain } from 'electron'

import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { WindowInfo } from '@shared/types'

import type { AppContext } from '../app-context'
import { createWinlistHelper, windowsChanged } from '../desktop/winlist'

/**
 * 桌面感知日志接口（L-4；与 `src/main/logger.ts` 的 Logger 结构兼容，避免硬依赖）。
 * 未注入时回退 console.warn（保持既有测试/调用方行为）。
 */
export interface DesktopIpcLogger {
  warn(message: string, meta?: unknown): void
}

/**
 * 窗口列表轮询周期（PLAN §4：「每 250–500ms 拉取一次即可」）。
 *
 * 2026-11-09 放置/落地修复：从 500ms 降到 250ms——拖拽松手瞬间的窗口几何最多滞后一个周期，
 * 250ms 让「放在窗口上」的吸附目标（窗口上沿）更接近用户松手时的真实布局；Swift 助手是
 * 一次性枚举（<10ms）、无录屏权限，250ms 周期 CPU 代价可接受。
 */
export const POLL_INTERVAL_MS = 250

/**
 * 注册桌面感知领域 handler（ready 后由 `ipc/index.ts` 聚合调用一次）。
 *
 * 行为：
 * - `pet:windows` 返回主进程缓存的最新窗口列表（首次轮询完成前为 `[]`）；
 * - 内部自启 250ms 轮询：第一次成功的列表只作为基线（不广播），之后仅在
 *   `windowsChanged` 为真时更新缓存并 `ctx.broadcast('windows-updated', windows)`；
 * - 助手失败（二进制缺失 / 超时 / 非 0 退出）时**保留旧缓存**、不广播空列表，
 *   连续失败只在首次 warn；
 * - `will-quit` 清理定时器；`timer.unref()` 不阻止进程退出。
 *
 * @param ctx 应用上下文（广播 `windows-updated`）
 * @param logger 进程级 logger（L-4 接线；可选，未注入时回退 console.warn）
 */
export function registerDesktopIpc(ctx: AppContext, logger?: DesktopIpcLogger): void {
  const helper = createWinlistHelper()
  /** 统一日志出口：注入 logger → 写 main.log；否则保持 console.warn。 */
  const warn = (message: string, meta?: unknown): void => {
    if (logger) logger.warn(message, meta)
    else if (meta === undefined) console.warn(message)
    else console.warn(message, meta)
  }

  /** 最新窗口列表缓存（`pet:windows` 返回值；由 poller 更新）。 */
  let cachedWindows: WindowInfo[] = []
  /**
   * 是否已完成首次成功轮询。
   *
   * A4-F03/F06（设计保留）：首份成功列表只做基线、**不广播**——避免启动期在 renderer
   * 尚未订阅 / 尚未完成首帧时广播，也避免把「首次拿到列表」误当成一次窗口变化。
   * 代价：B5 订阅 `windows-updated` 后必须先主动 `invoke('pet:windows')` 取基线
   * （native/winlist/README.md「消费方注意」已注明）。
   */
  let initialized = false
  /** 是否有一次轮询仍在进行（助手超时 > 轮询周期时避免堆积 spawn）。 */
  let polling = false
  /** 当前是否处于连续失败状态（只警告一次）。 */
  let failing = false
  /** 轮询定时器（will-quit / 重复注册时清理）。 */
  let timer: ReturnType<typeof setInterval> | null = null

  async function poll(): Promise<void> {
    if (polling) return
    polling = true
    try {
      const windows = await helper.list()
      const error = helper.lastError()

      if (error) {
        // 失败保留上一份缓存：短暂故障不应让 B5 收到空列表而「宠物掉下来」。
        if (!failing) {
          failing = true
          warn(`[desktop] winlist helper failed: ${error}`)
        }
        return
      }
      failing = false

      if (!initialized) {
        initialized = true
        cachedWindows = windows
        return
      }
      if (!windowsChanged(cachedWindows, windows)) return

      cachedWindows = windows
      ctx.broadcast(IPC_EVENTS.windowsUpdated, cachedWindows)
    } finally {
      polling = false
    }
  }

  /**
   * 触发一次轮询并兜底异常（A4-F05）。
   *
   * `helper.list()` 自身保证不 reject，但 `ctx.broadcast` → `webContents.send` 在极窄竞态
   * （webContents 失效但未 isDestroyed）可能抛；若不 catch，每 250ms 会产生一次
   * unhandled rejection。这里只 warn，下一轮继续。
   */
  function runPoll(): void {
    void poll().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      warn(`[desktop] winlist poll failed: ${message}`)
    })
  }

  function stopPolling(): void {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  // 只注册 `pet:windows`（move-window 归 C1；set-ignore-mouse/set-visible/quit 归 A1）。
  ipcMain.handle(IPC.windows, (): WindowInfo[] => cachedWindows)

  // 冷启动：立即轮询一次预热缓存（异步，不阻塞 IPC 注册），之后每 250ms 一次。
  runPoll()
  timer = setInterval(runPoll, POLL_INTERVAL_MS)
  timer.unref?.()
  app.once('will-quit', stopPolling)
}
