/**
 * 进程级当前配置访问点（Wave 3 集成，Lead-owned）
 *
 * 背景：配置 store 由 `src/main/ipc/config.ts::registerConfigIpc` 创建并独占写入；但 Wave 3
 * 新增的 DSH 生命周期（`src/main/ipc/dsh.ts`）、未来的窥屏服务等其它主进程领域模块也需要
 * **只读**访问当前生效配置（`dshCoupling` / `dshBubbleSync` 等），且要在设置面板改配置后即时
 * 生效。改造 AppContext 传递 store 会扩大冻结契约面，因此新增本进程级单例：
 *
 * - **单一写者**：只有 `registerConfigIpc` 在 store 初始化与每次 `pet:set-config` 成功后调用
 *   `setActiveConfig(next)`（next 已套用 backend env 覆盖，与 renderer 看到的一致）；
 * - **只读消费**：其它模块 `getActiveConfig()` 取独立副本 / `onActiveConfigChanged` 订阅变更；
 * - **安全降级**：未初始化时返回 `DEFAULT_CONFIG` 的副本，绝不抛异常；监听器异常被隔离；
 * - 单测：模块无 Electron 依赖，可 `resetActiveConfigForTests()` 隔离用例状态。
 *
 * 规则：不 import electron；本文件只做内存态转发，不读写磁盘。
 */
import { DEFAULT_CONFIG } from '@shared/config'
import type { PetConfig } from '@shared/types'

/** 当前生效配置（深一层浅拷贝即可：PetConfig 全是标量字段）。 */
let current: PetConfig = { ...DEFAULT_CONFIG }

/** 配置变更监听器集合（只读订阅；异常隔离，不影响其它监听器）。 */
const listeners = new Set<(config: PetConfig) => void>()

/**
 * 写入当前生效配置（唯一写者：config IPC）。会同步通知监听器（传副本）。
 */
export function setActiveConfig(next: PetConfig): void {
  current = { ...next }
  for (const listener of [...listeners]) {
    try {
      listener({ ...current })
    } catch {
      // 监听器异常不得影响配置保存/广播；静默隔离。
    }
  }
}

/** 读取当前生效配置的副本（未初始化时为 DEFAULT_CONFIG 副本）。 */
export function getActiveConfig(): PetConfig {
  return { ...current }
}

/**
 * 订阅配置变更（返回取消订阅函数；幂等）。
 */
export function onActiveConfigChanged(listener: (config: PetConfig) => void): () => void {
  listeners.add(listener)
  let active = true
  return () => {
    if (!active) return
    active = false
    listeners.delete(listener)
  }
}

/** 单测隔离：恢复默认配置并清空监听器（只应在测试中使用）。 */
export function resetActiveConfigForTests(): void {
  current = { ...DEFAULT_CONFIG }
  listeners.clear()
}
