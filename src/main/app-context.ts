/**
 * 主进程应用上下文 —— 集成骨架（Wave 1 开工前置；Wave 1 A1 合并窗口扩展为多屏）
 *
 * 职责（A1/A3/A4 等 Wave 1 任务在此之上接线，不再改 `src/main/index.ts`）：
 * - overlay 窗口注册表：**Wave 1 起每个显示器一个 overlay**（PLAN §17.3-2 / §17.5 P1-6），
 *   由 A1 的 `src/main/windows/overlay-manager.ts` 在同步显示器拓扑后调用
 *   `setOverlayWindows()` / `setPrimaryOverlay()` 登记；窗口关闭时由 manager 重新登记。
 * - 额外广播目标注册表（M-2）：设置窗等非 overlay 窗口可登记为广播目标，使
 *   `config-changed` 等主→渲染事件也能到达设置页；窗口关闭时由登记方注销。
 * - 类型安全的 `broadcast(channel, payload)`：把 `IPC_EVENTS` 事件推给所有广播目标。
 *
 * 不包含窗口创建 / 显示器换算 / 业务逻辑：
 * 窗口创建在 A1 的 `src/main/windows/**`，显示器转换在 `src/main/ipc/window.ts`（getDisplayInfos）。
 */
import type { BrowserWindow } from 'electron'
import type { IpcEventChannel, IpcEventPayload } from '@shared/ipc'

/** 供 main 进程各模块共享的应用上下文（进程级单例，见 createAppContext）。 */
export interface AppContext {
  /**
   * 登记 / 注销主显示器 overlay（窗口 closed 时传 null）。
   * A1 的多屏 manager 在重建后调用；单屏骨架（Wave 0）也继续可用。
   */
  setPrimaryOverlay(win: BrowserWindow | null): void
  /** 取主显示器 overlay；未创建或已销毁时返回 null。 */
  getPrimaryOverlay(): BrowserWindow | null
  /**
   * 用新的 overlay 窗口列表整体替换注册表（A1 多屏 manager 调用）。
   * 只登记仍存活的窗口；列表外的旧窗口会被移除登记（窗口本身由调用方销毁）。
   */
  setOverlayWindows(wins: BrowserWindow[]): void
  /** 当前仍存活的 overlay 窗口列表（广播目标；已销毁的窗口会被跳过）。 */
  getOverlayWindows(): BrowserWindow[]
  /**
   * 登记一个额外广播目标窗口（M-2：设置窗等非 overlay 窗口）。
   *
   * 声明为**可选方法**：既有测试/调用方的 AppContext stub 不必立即实现；
   * 未实现时广播仍只覆盖 overlay（向后兼容）。
   */
  registerBroadcastTarget?(win: BrowserWindow | null): void
  /** 注销额外广播目标（M-2；幂等，未登记/已销毁时为 no-op）。 */
  unregisterBroadcastTarget?(win: BrowserWindow | null): void
  /** 当前全部广播目标（overlay + 额外窗口，去重且过滤已销毁；M-2 排障/测试用）。 */
  getBroadcastTargets?(): BrowserWindow[]
  /** 向所有广播目标（overlay + 额外窗口）的 renderer 广播主→渲染事件。 */
  broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEventPayload<K>): void
}

/** 创建进程级单例上下文（`src/main/index.ts` 启动时创建一次）。 */
export function createAppContext(): AppContext {
  let overlayWindows: BrowserWindow[] = []
  let primaryOverlay: BrowserWindow | null = null
  /** 额外广播目标（设置窗等；M-2）。 */
  let broadcastTargets: BrowserWindow[] = []

  /** 过滤已销毁窗口（调用方可能来不及从注册表移除）。 */
  function aliveOverlays(): BrowserWindow[] {
    overlayWindows = overlayWindows.filter((win) => !win.isDestroyed())
    return overlayWindows
  }

  /** 过滤已销毁的额外广播目标。 */
  function aliveBroadcastTargets(): BrowserWindow[] {
    broadcastTargets = broadcastTargets.filter((win) => !win.isDestroyed())
    return broadcastTargets
  }

  /** 实际广播目标：overlay + 额外窗口（去重，避免同一窗口收到两次）。 */
  function allBroadcastTargets(): BrowserWindow[] {
    const merged = [...aliveOverlays(), ...aliveBroadcastTargets()]
    return merged.filter((win, index) => merged.indexOf(win) === index)
  }

  return {
    setPrimaryOverlay(win: BrowserWindow | null): void {
      if (win && win.isDestroyed()) win = null
      primaryOverlay = win
      // 单屏骨架兼容：显式设置 primary 时同步纳入注册表。
      if (win && !overlayWindows.includes(win)) overlayWindows = [...overlayWindows, win]
    },
    getPrimaryOverlay(): BrowserWindow | null {
      const overlays = aliveOverlays()
      if (primaryOverlay && !primaryOverlay.isDestroyed()) return primaryOverlay
      primaryOverlay = null
      return overlays[0] ?? null
    },
    setOverlayWindows(wins: BrowserWindow[]): void {
      overlayWindows = wins.filter((win) => !win.isDestroyed())
      if (primaryOverlay && !overlayWindows.includes(primaryOverlay)) primaryOverlay = null
    },
    getOverlayWindows(): BrowserWindow[] {
      return aliveOverlays()
    },
    registerBroadcastTarget(win: BrowserWindow | null): void {
      if (!win || win.isDestroyed()) return
      if (!broadcastTargets.includes(win)) broadcastTargets = [...broadcastTargets, win]
    },
    unregisterBroadcastTarget(win: BrowserWindow | null): void {
      if (!win) return
      broadcastTargets = broadcastTargets.filter((entry) => entry !== win)
    },
    getBroadcastTargets(): BrowserWindow[] {
      return allBroadcastTargets()
    },
    broadcast(channel, payload): void {
      for (const win of allBroadcastTargets()) {
        if (win.webContents.isDestroyed()) continue
        win.webContents.send(channel, payload)
      }
    }
  }
}
