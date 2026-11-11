/**
 * 配置相关 IPC 注册入口（Wave 1 A3）—— `pet:get-config` / `pet:set-config`。
 *
 * 实现要点（PLAN §8 / §17.3-4 / §17.5 A3）：
 * - 注册时机：只在 `app.whenReady()` 之后的 `registerIpcHandlers(ctx)` 里调用一次
 *   （**module 顶层不调用 `app.getPath`**，避免 ready 前访问报错；重复 `ipcMain.handle`
 *   同一 channel 会抛错，故本文件只注册这两个 channel）。
 * - 目录：`mkdirSync(app.getPath('userData'), { recursive: true })`，配置写 `userData/config.json`；
 *   日志写 `userData/logs/main.log`（`PET_PROFILE` 下 dev 各 worktree 的 userData 已隔离，见 index.ts）。
 * - `pet:get-config` → 返回当前完整配置（store.get 的独立副本）。
 * - `pet:set-config` → 入参任意：先 `toConfigPartial` 防御性清洗（只保留显式提供的合法键），
 *   再由 store 合并 + sanitizeConfig + 原子写盘，随后 `broadcast('config-changed', next)` 热更
 *   renderer（A2 订阅后按新 fpsCap 等即时生效），并把最终配置返回给调用方。
 */
import { app, ipcMain } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG, sanitizeConfig } from '@shared/config'
import { IPC, IPC_EVENTS } from '@shared/ipc'
import type { PetConfig } from '@shared/types'
import type { AppContext } from '../app-context'
import { applyBackendEnvOverrides, hasBackendEnvOverride, resolveBackendFlags } from '../backend-flags'
import { setActiveConfig } from '../config-access'
import { createConfigStore, toConfigPartial } from '../config-store'
import type { ConfigStore } from '../config-store'
import { applyLaunchAtLogin } from '../login-item'
import { createLogger } from '../logger'
import type { Logger } from '../logger'

/**
 * 极端降级用的内存配置 store：`userData` 完全不可用 / store 构造异常时兜底。
 * 语义与 `createConfigStore` 的 set 一致（合并 + sanitizeConfig），只是永不落盘。
 */
function createMemoryConfigStore(dir: string): ConfigStore {
  let current: PetConfig = { ...DEFAULT_CONFIG }
  return {
    filePath: join(dir, 'config.json'),
    get(): PetConfig {
      return { ...current }
    },
    set(partial: Partial<PetConfig>): PetConfig {
      current = sanitizeConfig({ ...current, ...(partial as Record<string, unknown>) })
      return { ...current }
    }
  }
}

/**
 * 注册配置领域 handler（ready 后由 `ipc/index.ts` 聚合调用一次）。
 * 不注册其它 channel，也不改 `src/main/index.ts` / `src/main/ipc/index.ts`（Lead-owned 集成骨架）。
 *
 * 容错（M-11）：userData 不可写/不可创建时不得让 bootstrap 抛错退出——
 * `mkdirSync` 失败只 console.warn 后继续（store/logger 已能内存态降级）；
 * 若 store 构造仍异常，再降级为纯内存配置，保证 `pet:get-config`/`pet:set-config` 可用。
 *
 * @param ctx 应用上下文（`pet:set-config` 后广播 `config-changed`）
 * @param logger 进程级 logger（L-3；可选，未注入时保持原先自建实例的行为，单测兼容）
 */
export function registerConfigIpc(ctx: AppContext, logger?: Logger): void {
  const userDataDir = app.getPath('userData')
  try {
    mkdirSync(userDataDir, { recursive: true })
  } catch (error) {
    // 不阻塞启动：后续 logger/store 对不可写目录各自降级（日志丢失、配置仅内存态）。
    console.warn('[config] 无法创建 userData 目录，配置/日志将降级（可能不落盘）:', error)
  }

  // L-3：优先复用 bootstrap 注入的进程级 logger —— 同一 `main.log` 不再有两个独立
  // Logger 实例各自轮转；未注入（单测 / 旧调用方）时回退为原有自建 logger。
  const log = logger ?? createLogger({ dir: join(userDataDir, 'logs') })
  let store: ConfigStore
  try {
    store = createConfigStore({ dir: userDataDir, logger: log })
  } catch (error) {
    // config-store 设计上「绝不抛」，这里是最后防线：保证设置面板 IPC 仍可用。
    console.warn('[config] 配置存储初始化失败，降级为内存配置:', error)
    store = createMemoryConfigStore(userDataDir)
  }

  // Wave 3 集成：把当前生效配置暴露给其它主进程领域模块（dsh 生命周期等只读消费）。
  setActiveConfig(applyBackendEnvOverrides(store.get()))

  // Wave 2 集成：启动时按持久化配置应用「开机自启」（dev 模式跳过，见 login-item.ts）。
  const initialLaunchAtLogin = applyLaunchAtLogin(store.get().launchAtLogin)
  log.info('[config] launchAtLogin 应用结果', initialLaunchAtLogin)

  // V1：renderer 读不到 process.env，主进程在 IPC 边界套用后端 env 覆盖（get/set/broadcast 一致）。
  ipcMain.handle(IPC.getConfig, (): PetConfig => applyBackendEnvOverrides(store.get()))

  // 入参声明为 unknown：renderer 可能传任意结构（旧版本 / 手工伪造），一律当脏输入处理。
  ipcMain.handle(IPC.setConfig, (_event, rawInput: unknown): PetConfig => {
    const previous = store.get()
    const stored = store.set(toConfigPartial(rawInput))
    const next = applyBackendEnvOverrides(stored)
    // Wave 2 集成：launchAtLogin 变更需要同步系统登录项（幂等，成功与否不阻塞配置保存）。
    if (next.launchAtLogin !== previous.launchAtLogin) {
      const result = applyLaunchAtLogin(next.launchAtLogin)
      log.info('[config] launchAtLogin 变更', { enabled: next.launchAtLogin, result })
    }
    // Wave 3：配置变更后同步进程级只读配置快照（dsh 生命周期等按最新开关热生效）。
    setActiveConfig(next)
    ctx.broadcast(IPC_EVENTS.configChanged, next)
    return next
  })

  const flags = resolveBackendFlags(store.get())
  log.info('[config] 配置 IPC 已注册', {
    userDataDir,
    configFile: store.filePath,
    effectiveBackends: flags,
    envOverride: hasBackendEnvOverride()
  })
}
