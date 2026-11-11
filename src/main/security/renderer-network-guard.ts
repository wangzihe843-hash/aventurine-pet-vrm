/**
 * Renderer 出站网络兜底 + URL 日志脱敏（R-22 / R-23）
 *
 * R-23（复核 P2）：`hardenSession()` 此前只有权限 handler，main 侧对 renderer 出站网络
 * 零限制 —— 唯一防线是 HTML meta CSP。本模块在 `isPackaged`（生产）时给默认 session 挂
 * `webRequest.onBeforeRequest`，**只拦 http(s)**（filter 固定为 `RENDERER_NETWORK_FILTER`，见下）：
 * - 生产页面走 `file://`、素材走 `pet-asset://`，两者不受 filter 影响（不能被误伤）；
 * - dev server 走 http://localhost，但 dev 下本模块整体不注册（`isPackaged === false`）；
 * - 不做 `onHeadersReceived` 强制 CSP：生产 HTML 已有 meta CSP（`default-src 'self'`
 *   等），session 层回写容易与 dev 的 ws / vite HMR 冲突，且 meta CSP 已在 HTML 中；
 * - 不拦 `file://` / `pet-asset://` / `devtools://` 等，避免打断自身页面与协议加载。
 *
 * R-22（复核 P2）：拒绝导航 / 拒绝网络请求的日志原先记录完整 URL（含 query 里的 token
 * 之类敏感值，会落到 `main.log`，1MB 轮转）。`maskUrl()` 只保留 protocol + origin
 * （host:port），非法 / 非字符串记 `<invalid-url>`；日志统一用它脱敏。
 *
 * 本模块**不 import electron**（session 用结构类型）：既是纯函数可单测，
 * 也避免在 vitest 里为了测脱敏而 mock 整个 Electron。
 */

/** URL 脱敏结果：非法 URL 的统一占位。 */
export const INVALID_URL_PLACEHOLDER = '<invalid-url>'

/** 脱敏日志器最小面（与 `src/main/logger.ts` 的 Logger 兼容）。 */
export interface RendererNetworkGuardLogger {
  warn(message: string, meta?: unknown): void
}

/** `webRequest.onBeforeRequest` 的 filter（固定；测试断言「不拦 file/pet-asset/dev 路径」）。 */
export const RENDERER_NETWORK_FILTER = Object.freeze({
  urls: Object.freeze(['http://*/*', 'https://*/*'])
}) as unknown as { urls: string[] }

/** `onBeforeRequest` 回调参数的最小面（Electron 结构兼容）。 */
export interface BeforeRequestDetails {
  url?: string
  resourceType?: string
  webContentsId?: number
}

/** `onBeforeRequest` 的取消回调（Electron `CallbackResponse` 结构兼容）。 */
export interface BeforeRequestCallback {
  (response: { cancel: boolean }): void
}

/**
 * renderer session 的最小面：只依赖 `webRequest.onBeforeRequest`。
 * Electron `Session` 结构兼容（方法参数逆变由 method bivariance 放行）。
 */
export interface RendererNetworkGuardSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: BeforeRequestDetails, callback: BeforeRequestCallback) => void
    ): void
  }
}

/** `installRendererNetworkGuard` 选项。 */
export interface InstallRendererNetworkGuardOptions {
  /** 仅打包版注册（dev 需要 http dev server / HMR ws）。 */
  isPackaged: boolean
  /** 日志接收器（可选；未注入时只取消请求不记日志）。 */
  logger?: RendererNetworkGuardLogger
  /** 自定义脱敏函数（默认本模块 `maskUrl`；测试/排障可注入）。 */
  maskUrl?: (url: unknown) => string
}

/**
 * 日志用 URL 脱敏（R-22）。
 *
 * - 合法 URL → `${protocol}//${host}`（如 `https://evil.example`；丢弃 path/query/hash，
 *   避免把 query 里的 token / session 值持久化到 `main.log`）；
 * - 无 host 的 scheme（`file:` / `about:` 等）→ 只记 protocol（如 `file:`）；
 * - 非法 / 空 / 非字符串 → `<invalid-url>`；
 * - 绝不抛异常（日志路径不能因为脏 URL 崩掉）。
 */
export function maskUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return INVALID_URL_PLACEHOLDER
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return INVALID_URL_PLACEHOLDER
  }
  // `file:///Users/...` / `about:blank` 的 host 为空：只保留 protocol，不泄露本地路径。
  if (parsed.host.length === 0) return parsed.protocol
  return `${parsed.protocol}//${parsed.host}`
}

/**
 * 安装 renderer 出站网络兜底。
 *
 * @returns 是否实际注册（非打包版返回 false，便于调用方/测试断言）
 */
export function installRendererNetworkGuard(
  ses: RendererNetworkGuardSession,
  options: InstallRendererNetworkGuardOptions
): boolean {
  if (!options.isPackaged) return false
  const log = options.logger
  const redact = options.maskUrl ?? maskUrl
  ses.webRequest.onBeforeRequest(RENDERER_NETWORK_FILTER, (details, callback) => {
    // 生产页面不需要任何 http(s) 出站：一律取消并只记脱敏后的来源。
    log?.warn(`[security] blocked renderer network request: ${redact(details?.url)}`)
    callback({ cancel: true })
  })
  return true
}
