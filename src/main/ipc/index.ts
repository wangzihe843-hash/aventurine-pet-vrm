/**
 * IPC 注册聚合器 —— 集成骨架（Wave 1 开工前置）
 *
 * 各业务领域按文件拆分（window / config / desktop），`src/main/index.ts` 在 ready 后
 * 调用本函数一次即可；A1/A3/A4 并行时只填各自文件，不再互相改 `index.ts`（PLAN §15 规则 2）。
 *
 * L-3/L-4：可选的进程级 logger 从这里下发（config 复用同一实例写 `main.log`，
 * dsh-watch / desktop poller / settings-window 接入文件日志）；未传时各模块保持原有
 * console 回退，测试 stub 无需改动。
 */
import type { Logger } from '../logger'
import type { AppContext } from '../app-context'
import { registerConfigIpc } from './config'
import { registerDesktopIpc } from './desktop'
import { registerDshIpc } from './dsh'
import { registerSettingsIpc } from './settings'
import { registerWindowIpc } from './window'

/**
 * 按领域注册全部 invoke handler（ipcMain.handle 同一 channel 重复注册会抛错，只应调用一次）。
 *
 * Wave 2 增量：
 * - `settings.ts`（Lead 预置）：`pet:show-settings`；
 * - `dsh.ts`（B7）：`pet:dsh-status` —— 文件由 B7 创建，Lead 在此接线；
 *   若 B7 尚未落地，`registerDshIpc` 未实现会导致编译失败，故由 Lead 在集成窗口添加。
 *
 * @param ctx 进程级应用上下文（overlay 注册表 + 广播）
 * @param logger 进程级 logger（L-3/L-4；可选，未传时各模块回退 console）
 */
export function registerIpcHandlers(ctx: AppContext, logger?: Logger): void {
  registerWindowIpc(ctx)
  registerConfigIpc(ctx, logger)
  registerDesktopIpc(ctx, logger)
  registerSettingsIpc(ctx, logger)
  registerDshIpc(ctx, logger)
}
