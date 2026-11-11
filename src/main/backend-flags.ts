/**
 * 主进程后端 flag 解析（V1 接线）。
 *
 * 契约（W0-3 冻结）：`PET_MODEL_BACKEND` / `PET_ANIM_BACKEND` 环境变量 > config.json > 默认 `vrm`
 * （解析函数在 `src/shared/vrm.ts` / `src/shared/animation-contract.ts`）。
 *
 * renderer 是 sandbox 渲染进程，读不到 `process.env`，因此**由主进程在 IPC 边界统一套用覆盖**：
 * `pet:get-config` / `pet:set-config` 返回、`config-changed` 广播的都是「生效值」。
 * config.json 里仍保存用户设置原值（env 覆盖不落盘），移除 env 后下次启动自动回到用户设置。
 *
 * 本模块纯函数（不 import Electron），便于单测。
 */
import { resolveAnimationBackend } from '@shared/animation-contract'
import type { AnimationBackend, ModelBackend, PetConfig } from '@shared/types'
import { resolveModelBackend } from '@shared/vrm'

/** 生效的后端组合（供主进程 smoke/日志/未来托盘菜单使用）。 */
export interface EffectiveBackendFlags {
  modelBackend: ModelBackend
  animBackend: AnimationBackend
}

/** 环境变量字典类型（`process.env` 兼容；单测传普通对象）。 */
export type BackendEnv = Readonly<Record<string, string | undefined>>

/** 解析生效后端（env > config > 默认 vrm；非法值自动回退）。 */
export function resolveBackendFlags(
  config: Pick<PetConfig, 'modelBackend' | 'animBackend'>,
  env: BackendEnv = process.env
): EffectiveBackendFlags {
  return {
    modelBackend: resolveModelBackend(env.PET_MODEL_BACKEND, config.modelBackend),
    animBackend: resolveAnimationBackend(env.PET_ANIM_BACKEND, config.animBackend)
  }
}

/**
 * 返回套用 env 覆盖后的配置副本（只改 `modelBackend`/`animBackend` 两键）。
 * 其它字段原样保留（调用方通常已 sanitize 过）。
 */
export function applyBackendEnvOverrides(config: PetConfig, env: BackendEnv = process.env): PetConfig {
  const flags = resolveBackendFlags(config, env)
  return {
    ...config,
    modelBackend: flags.modelBackend,
    animBackend: flags.animBackend
  }
}

/** 当前环境是否显式设置了后端变量（日志用；不做合法性判断）。 */
export function hasBackendEnvOverride(env: BackendEnv = process.env): boolean {
  return (
    (typeof env.PET_MODEL_BACKEND === 'string' && env.PET_MODEL_BACKEND.trim().length > 0) ||
    (typeof env.PET_ANIM_BACKEND === 'string' && env.PET_ANIM_BACKEND.trim().length > 0)
  )
}
