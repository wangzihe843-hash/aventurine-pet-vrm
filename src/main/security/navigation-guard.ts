/**
 * overlay 导航放行判定（B-02 生产态 context-lost 恢复补丁）。
 *
 * 背景（二次复核发现）：
 * - `src/renderer/src/vrm/pet-scene-vrm.ts` 在 WebGL context 丢失后走 `window.location.reload()`
 *   作为唯一恢复路径；
 * - renderer 发起的 reload 会触发 `will-navigate`，而 `src/main/index.ts` 的
 *   `hardenWebContents()` 对 `will-navigate` / `will-redirect` 一律 `preventDefault()`；
 * - 生产态（`file://` 页面）不满足 `isAllowedNavigation()`（仅 dev server 同源），因此 reload
 *   被主进程取消 —— B-02 修复在生产态实际不生效（二次复核用 Electron 44 探针实测确认）。
 *
 * 本模块提供唯一需要的放行例外：**目标 URL 与当前文档 URL 完全相等**的导航。
 * - 这是浏览器对 `location.reload()` 的行为（reload 的目标就是当前文档 URL），不会加载新文档、
 *   不改变 origin/path/query/hash，因此不扩大攻击面；
 * - 采用**原始字符串完全相等**为安全边界（不做 URL 归一化）：避免把 `http://a/` 与 `http://a`
 *   之类不同写法误判为同文档；Electron 44 实测 file://（含百分号编码中文路径）、带 `#hash`、
 *   query string 场景下 reload 的 `will-navigate` target 与 `webContents.getURL()` 逐字符相等；
 * - `will-redirect` 不走本函数（重定向始终全拒）。
 *
 * 纯函数、不 import electron，便于 node 环境单测。
 */

/**
 * 判断目标 URL 是否与「当前文档 URL」完全相等。
 *
 * **安全前提**：`currentUrl` 必须来自「真实提交的导航」（`did-navigate` 记录值），
 * **不能**直接用 `webContents.getURL()` —— 后者返回 renderer 可写的 visible URL：
 * renderer 先 `history.replaceState(null, '', '<其它 URL>')` 再 `location.reload()` 时，
 * will-navigate 的 target 会等于被篡改后的 getURL()，逐字符比较就会放行**真实文档导航**
 * （二次复核用 Electron 44 探针实测：可跳转到其它 file:// 甚至远程 https 页面）。
 * 见 `createCommittedUrlTracker`。
 *
 * @param currentUrl 最近一次**真实提交**的文档 URL（`did-navigate`）
 * @param targetUrl  `will-navigate` 事件的目标 URL
 * @returns true = 与当前文档 URL 完全相等（放行 reload）；false = 正常运行拦截
 */
export function isSameUrlReload(currentUrl: unknown, targetUrl: unknown): boolean {
  if (typeof currentUrl !== 'string' || typeof targetUrl !== 'string') return false
  if (currentUrl.length === 0 || targetUrl.length === 0) return false
  return currentUrl === targetUrl
}

/** 「最近一次真实提交 URL」跟踪器（安全口径：只接受 `did-navigate` 的 URL）。 */
export interface CommittedUrlTracker {
  /** 记录一次真实提交的 URL（只应由 `did-navigate` 调用；非 string 忽略）。 */
  noteCommitted(url: unknown): void
  /** 最近一次真实提交的 URL（空串 = 尚未提交过）。 */
  committed(): string
  /** 目标是否等于最近一次真实提交的 URL（= 当前文档 reload；放行判定用这个）。 */
  isSameUrlReload(targetUrl: unknown): boolean
}

/**
 * 创建「真实提交 URL」跟踪器。
 *
 * 为什么不能直接用 `webContents.getURL()`：该值可被 renderer 的 `history.replaceState`
 * 改写（visible URL），而 `did-navigate` 只在**真实文档提交**时触发（replaceState /
 * pushState / hash 变化走 `did-navigate-in-page`，不会更新本跟踪器）—— 因此把放行依据从
 * getURL() 换成 committedUrl 后，replaceState 篡改无法再伪造「同 URL」。
 *
 * @param initialUrl 初始 URL（可选；生产接线传 `webContents.getURL()` 作起点，首次
 *   `did-navigate` 后即被真实提交值覆盖）
 */
export function createCommittedUrlTracker(initialUrl?: unknown): CommittedUrlTracker {
  let committed = typeof initialUrl === 'string' ? initialUrl : ''
  return {
    noteCommitted(url: unknown): void {
      if (typeof url === 'string' && url.length > 0) committed = url
    },
    committed(): string {
      return committed
    },
    isSameUrlReload(targetUrl: unknown): boolean {
      return isSameUrlReload(committed, targetUrl)
    }
  }
}
