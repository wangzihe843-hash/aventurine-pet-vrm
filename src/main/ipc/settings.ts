/**
 * 设置窗相关 IPC 注册入口（Wave 2 开工前置，Lead-owned）
 *
 * 已注册（冻结契约 `src/shared/ipc.ts`）：
 * - `pet:show-settings`：打开/聚焦设置窗（AGENT PLAN §19.6 未注册清单之一）。
 *
 * 所有权说明：
 * - `pet:notify` 归 Wave 3 C3；`pet:dsh-status` 归 Wave 2 B7（`ipc/dsh.ts`）；
 * - 本文件只注册 `pet:show-settings`，不得注册其它 channel（重复 `ipcMain.handle` 会抛错）。
 *
 * M-2：打开设置窗时传入 AppContext，使设置窗登记为 `config-changed` 广播目标；
 * L-4：可选注入共享 logger（未注入时设置窗回退 console，兼容既有调用方/测试）。
 */
import { ipcMain } from 'electron'

import { IPC } from '@shared/ipc'

import type { AppContext } from '../app-context'
import { openSettingsWindow } from '../windows/settings-window'
import type { SettingsWindowLogger } from '../windows/settings-window'

/**
 * 注册设置窗领域 handler（ready 后由 `ipc/index.ts` 聚合调用一次）。
 *
 * @param ctx 应用上下文（设置窗登记为广播目标用；M-2）
 * @param logger 共享日志（L-4；可选）
 */
export function registerSettingsIpc(ctx: AppContext, logger?: SettingsWindowLogger): void {
  ipcMain.handle(IPC.showSettings, (): void => {
    openSettingsWindow(ctx, logger)
  })
}
