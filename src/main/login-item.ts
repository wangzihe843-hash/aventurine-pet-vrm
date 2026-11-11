/**
 * 开机自启（登录项）应用逻辑 —— `PetConfig.launchAtLogin` 的宿主侧实现。
 *
 * 背景（PLAN §5-B6 / §10）：
 * - 设置面板（B6）提供「开机自启」开关，配置由 `pet:set-config` 持久化；
 * - 但真正写系统登录项必须在主进程用 `app.setLoginItemSettings`（Wave 3 C3 的「系统集成」
 *   只覆盖通知/声音/权限引导，不接管登录项），因此本模块由 Lead 在 Wave 2 集成。
 *
 * 平台 / 开发语义：
 * - **dev（!app.isPackaged）不写登录项**：`app.setLoginItemSettings` 在 dev 下指向 Electron
 *   二进制本身（会注册一个奇怪的登录项），只记录日志；打包版（C4）才是真实验收路径；
 * - macOS：`openAtLogin`；`openAsHidden` 仅旧系统版本有效，保留兼容传参。
 * - 任何异常只 warn 不抛（登录项失败不能阻断启动/保存设置）。
 */
import { app } from 'electron'

/** 应用登录项结果（供设置面板/日志展示）。 */
export interface LaunchAtLoginResult {
  /** 配置目标状态（用户期望） */
  enabled: boolean
  /** 是否真的调用了系统 API（dev 下为 false） */
  applied: boolean
  /** dev 跳过 / 平台不支持 / 异常时的原因 */
  reason?: 'dev' | 'unsupported-platform' | 'error'
}

/**
 * 应用 `launchAtLogin` 配置（幂等；可在启动与每次 set-config 后调用）。
 */
export function applyLaunchAtLogin(enabled: boolean): LaunchAtLoginResult {
  if (!app.isPackaged) {
    console.log(`[login-item] dev 模式跳过登录项写入（launchAtLogin=${enabled}）`)
    return { enabled, applied: false, reason: 'dev' }
  }
  if (process.platform !== 'darwin') {
    return { enabled, applied: false, reason: 'unsupported-platform' }
  }
  try {
    // Electron 44 的 `Settings` 类型已移除 `openAsHidden`（旧 macOS 兼容字段），
    // 只传 `openAtLogin`；如需额外启动参数用 `args`。
    app.setLoginItemSettings({ openAtLogin: enabled })
    return { enabled, applied: true }
  } catch (error) {
    console.warn('[login-item] 写入登录项失败（不影响其它功能）:', error)
    return { enabled, applied: false, reason: 'error' }
  }
}
