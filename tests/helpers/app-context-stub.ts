/**
 * AppContext stub（Wave 1 M-5 测试基建）。
 *
 * 与 `src/main/app-context.ts` 的接口一致，但额外暴露内部记录数组便于断言：
 * - `broadcasts`：`ctx.broadcast()` 调用（channel + payload）；
 * - `overlayWindows` / `primaryOverlay`：最近一次登记结果。
 *
 * 不 import electron 运行时（只 type-only），可在 vitest node 环境直接使用。
 */
import type { BrowserWindow } from 'electron'

import type { AppContext } from '../../src/main/app-context'
import type { IpcEventChannel, IpcEventPayload } from '../../src/shared/ipc'

/** 广播记录。 */
export interface BroadcastRecord<K extends IpcEventChannel = IpcEventChannel> {
  channel: K
  payload: IpcEventPayload<K>
}

/** 测试用 AppContext（接口兼容 + 内省字段）。 */
export interface AppContextStub extends AppContext {
  /** 全部 broadcast 调用（按顺序）。 */
  readonly broadcasts: BroadcastRecord[]
  /** 最近一次 `setOverlayWindows` 的入参（拷贝）。 */
  overlayWindows: BrowserWindow[]
  /** 最近一次 `setPrimaryOverlay` 的入参。 */
  primaryOverlay: BrowserWindow | null
}

/** 创建 AppContext stub。 */
export function createAppContextStub(): AppContextStub {
  let overlayWindows: BrowserWindow[] = []
  let primaryOverlay: BrowserWindow | null = null
  const broadcasts: BroadcastRecord[] = []

  const stub: AppContextStub = {
    broadcasts,
    get overlayWindows(): BrowserWindow[] {
      return overlayWindows
    },
    set overlayWindows(wins: BrowserWindow[]) {
      overlayWindows = wins
    },
    get primaryOverlay(): BrowserWindow | null {
      return primaryOverlay
    },
    set primaryOverlay(win: BrowserWindow | null) {
      primaryOverlay = win
    },
    setPrimaryOverlay(win: BrowserWindow | null): void {
      primaryOverlay = win
    },
    getPrimaryOverlay(): BrowserWindow | null {
      return primaryOverlay
    },
    setOverlayWindows(wins: BrowserWindow[]): void {
      overlayWindows = wins
    },
    getOverlayWindows(): BrowserWindow[] {
      return overlayWindows
    },
    broadcast<K extends IpcEventChannel>(channel: K, payload: IpcEventPayload<K>): void {
      broadcasts.push({ channel, payload })
    }
  }

  return stub
}

/** 清空广播记录（复用 stub 时用）。 */
export function clearAppContextBroadcasts(stub: AppContextStub): void {
  stub.broadcasts.length = 0
}
